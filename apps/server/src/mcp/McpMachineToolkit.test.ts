import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineView,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as MachineService from "../machines/MachineService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-machine-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-machine-test"),
  requestNamespace: "provider-session-machine-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-machine-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const SSH_CONFIG = "/state/machines/t/abc/ssh_config";
const machine = (name: string, state: MachineView["state"]): MachineView => ({
  name,
  profile: "vm",
  type: "virtual-machine",
  image: "ubuntu:24.04",
  cpus: 2,
  memoryGiB: 2,
  diskSizesGiB: [],
  state,
  hostLabel: "lab",
  dnsName: `${name}-1234abcd.lxd`,
  addresses: state === "ready" ? ["10.1.1.2"] : [],
  expiresAt: "2026-10-26T12:00:00.000Z",
  sshCommand: `ssh -F ${SSH_CONFIG} ${name}`,
});

const provider = (driver: string): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-10-25T00:00:00Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
});

function harness(input: {
  readonly runtimeMode: RuntimeMode;
  readonly driver?: string;
  readonly acquire?: MachineService.MachineService["Service"]["acquire"];
}) {
  const released: Array<string> = [];
  const layer = McpHttpServer.layerMachineToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(liveThreadShell(id, { runtimeMode: input.runtimeMode })),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider(input.driver ?? "codex")]),
        }),
        Layer.mock(MachineService.MachineService)({
          acquire:
            input.acquire ??
            ((request) => Effect.succeed(machine(request.name ?? `${request.profile}-1`, "ready"))),
          wait: (request) => Effect.succeed(machine(request.name, "starting")),
          list: () => Effect.succeed([machine("vm-1", "ready"), machine("db", "stopped")]),
          profiles: () => Effect.succeed([]),
          release: (request) => Effect.sync(() => void released.push(request.name)),
          sshConfigPath: () => SSH_CONFIG,
        }),
      ),
    ),
  );
  const call = (
    name: string,
    args: Record<string, unknown>,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["machines"],
  ) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            invocation(capabilities),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  const text = (result: { readonly content: ReadonlyArray<unknown> }) =>
    JSON.stringify(result.content);
  return { layer, call, text, released };
}

it.effect("refuses machine tools unless the project grants machine access", () => {
  const { layer, call, text } = harness({ runtimeMode: "full-access" });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "machine_acquire",
      "machine_list",
      "machine_release",
      "machine_wait",
    ]);
    const denied = yield* call("machine_acquire", { profile: "vm" }, ["device"]);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("Agent machine access is off for this project");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("tells the agent how to reach a machine and what to do while it boots", () => {
  const { layer, call, released } = harness({ runtimeMode: "full-access" });
  return Effect.gen(function* () {
    const acquired = yield* call("machine_acquire", { profile: "vm", name: "web" });
    expect(acquired.isError).toBe(false);
    const ready = acquired.structuredContent as { machine: { name: string }; next: string };
    expect(ready.machine.name).toBe("web");
    expect(ready.next).toContain(`ssh -F ${SSH_CONFIG} web '<command>'`);
    expect(ready.next).toContain("2026-10-26T12:00:00.000Z");
    expect(ready.next).not.toContain("sandbox");

    const waited = yield* call("machine_wait", { name: "web" });
    expect((waited.structuredContent as { next: string }).next).toContain(
      'Call machine_wait with name "web"',
    );

    const listed = yield* call("machine_list", { name: "db" });
    expect(listed.structuredContent).toMatchObject({
      machines: [{ name: "db", state: "stopped" }],
      sshConfig: SSH_CONFIG,
    });
    expect(listed.structuredContent).not.toHaveProperty("notice");

    expect((yield* call("machine_release", { name: "db" })).isError).toBe(false);
    expect(released).toEqual(["db"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("warns agents whose sandbox blocks ssh outside full access", () =>
  Effect.gen(function* () {
    const codex = harness({ runtimeMode: "auto" });
    const acquired = yield* codex
      .call("machine_acquire", { profile: "vm" })
      .pipe(Effect.scoped, Effect.provide(codex.layer));
    expect((acquired.structuredContent as { next: string }).next).toContain(
      "with escalated permissions",
    );

    const cursor = harness({ runtimeMode: "approval-required", driver: "cursor" });
    const listed = yield* cursor
      .call("machine_list", {})
      .pipe(Effect.scoped, Effect.provide(cursor.layer));
    expect((listed.structuredContent as { notice?: string }).notice).toContain("Full access");

    // Claude's shell runs outside any T3-configured sandbox in every mode.
    const claude = harness({ runtimeMode: "approval-required", driver: "claudeAgent" });
    const unsandboxed = yield* claude
      .call("machine_list", {})
      .pipe(Effect.scoped, Effect.provide(claude.layer));
    expect(unsandboxed.structuredContent).not.toHaveProperty("notice");
  }),
);

it.effect("passes the service's refusal to the agent", () => {
  const { layer, call, text } = harness({
    runtimeMode: "full-access",
    acquire: () =>
      Effect.fail(
        new MachineService.MachineRefusedError({
          reason: "unknown-profile",
          subject: "gpu",
          options: ["vm", "box"],
        }),
      ),
  });
  return Effect.gen(function* () {
    const refused = yield* call("machine_acquire", { profile: "gpu" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(
      "There's no machine profile called gpu. This project has vm, box.",
    );
  }).pipe(Effect.scoped, Effect.provide(layer));
});
