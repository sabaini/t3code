/**
 * T3's machine tools over a case's world. McpHttpServer's machine toolkit runs T3's handlers on a
 * MachineService that keeps the world's machines in memory, so every result and refusal the agent
 * sees is T3's. Machines are ready as soon as they are acquired; the shell simulator plays them.
 */
import {
  EnvironmentId,
  type MachineProfile,
  type MachineView,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the machine tools McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import * as MachineService from "@t3tools/machines/MachineService";
import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../apps/server/src/provider/ProviderRegistry.ts";

export interface MachineWorld {
  /** The project's machine profiles. Defaults to one Ubuntu VM and one container. */
  readonly machineProfiles?: ReadonlyArray<MachineProfile> | undefined;
  /** true: the project turned on agent machine access, so the session holds `machines`. */
  readonly machineAgentAccess?: boolean | undefined;
  /** Machines another thread of the project already made, by name and profile. */
  readonly projectMachines?:
    | ReadonlyArray<{ readonly name: string; readonly profile: string }>
    | undefined;
}

const DEFAULT_PROFILES: ReadonlyArray<MachineProfile> = [
  {
    name: "vm",
    image: "ubuntu:24.04",
    type: "virtual-machine",
    lxdProfiles: ["default"],
    cpus: 2,
    memoryGiB: 4,
    diskSizesGiB: [],
    lifetimeHours: 24,
  },
  {
    name: "container",
    image: "ubuntu:24.04",
    type: "container",
    lxdProfiles: ["default"],
    cpus: 2,
    memoryGiB: 2,
    diskSizesGiB: [],
    lifetimeHours: 24,
  },
];

const THREAD = ThreadId.make("mcp-tool-use-eval");
const OTHER_THREAD = ThreadId.make("mcp-tool-use-eval-other");
const SSH_CONFIG = "/home/user/.t3/userdata/machines/mcp-tool-use-eval/ssh_config";
const EXPIRES_AT = "2026-01-02T12:00:00.000Z";

export const isMachineTool = (name: string) => name.startsWith("machine_");

export const makeMachineTools = Effect.fn("evaluateMcpToolUse.makeMachineTools")(function* (
  world: MachineWorld,
) {
  const profiles = world.machineProfiles ?? DEFAULT_PROFILES;
  const machines = new Map<string, MachineView>();
  let created = 0;
  const view = (name: string, profile: MachineProfile, threadId: ThreadId): MachineView => {
    created++;
    return {
      name,
      profile: profile.name,
      type: profile.type,
      image: profile.image,
      cpus: profile.cpus,
      memoryGiB: profile.memoryGiB,
      diskSizesGiB: profile.diskSizesGiB,
      state: "ready",
      hostLabel: "lab",
      dnsName: `${name}-3f9a2c1b.lxd`,
      addresses: [`10.84.0.${created + 1}`],
      expiresAt: EXPIRES_AT,
      sshCommand: `ssh -F ${SSH_CONFIG} ${name}`,
      threadId,
    };
  };
  for (const existing of world.projectMachines ?? []) {
    const profile = profiles.find((candidate) => candidate.name === existing.profile);
    if (profile === undefined) return yield* Effect.die(`No profile ${existing.profile}`);
    machines.set(existing.name, view(existing.name, profile, OTHER_THREAD));
  }
  const refused = (
    reason: MachineService.MachineRefusedError["reason"],
    subject?: string,
    options?: ReadonlyArray<string>,
  ) =>
    new MachineService.MachineRefusedError({
      reason,
      ...(subject === undefined ? {} : { subject }),
      ...(options === undefined ? {} : { options }),
    });
  const machineNamed = (
    name: string,
  ): Effect.Effect<MachineView, MachineService.MachineRefusedError> => {
    const machine = machines.get(name);
    return machine === undefined
      ? Effect.fail(refused("not-found", name))
      : Effect.succeed(machine);
  };
  const service = Layer.mock(MachineService.MachineService)({
    list: () => Effect.succeed([...machines.values()]),
    profiles: () => Effect.succeed(profiles),
    sshConfigPath: () => SSH_CONFIG,
    acquire: Effect.fn("MachineService.acquire")(function* (request) {
      const profile = profiles.find((candidate) => candidate.name === request.profile);
      if (profile === undefined) {
        return yield* refused(
          "unknown-profile",
          request.profile,
          profiles.map((candidate) => candidate.name),
        );
      }
      if (machines.size >= MachineService.MAX_MACHINES_PER_PROJECT) {
        return yield* refused("limit");
      }
      let name = request.name;
      if (name === undefined) {
        let n = 1;
        while (machines.has(`${profile.name}-${n}`)) n++;
        name = `${profile.name}-${n}`;
      } else if (machines.has(name)) {
        return yield* refused("name-taken", name);
      }
      const machine = view(name, profile, request.threadId);
      machines.set(name, machine);
      return machine;
    }),
    wait: (request) => machineNamed(request.name),
    release: (request) =>
      machineNamed(request.name).pipe(Effect.map(() => void machines.delete(request.name))),
  });
  const context = yield* Layer.build(
    McpHttpServer.layerMachineToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(
        Layer.mergeAll(
          service,
          // Full access: no sandbox notice applies.
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(liveThreadShell(id, { runtimeMode: "full-access" })),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              {
                driver: ProviderDriverKind.make("codex"),
                instanceId: ProviderInstanceId.make("codex"),
                enabled: true,
                installed: true,
                version: "1.0.0",
                status: "ready",
                checkedAt: "2026-01-01T00:00:00Z",
                auth: { status: "authenticated" },
                models: [],
                skills: [],
                slashCommands: [],
              },
            ]),
          }),
        ),
      ),
    ),
  );
  const server = Context.get(context, McpServer.McpServer);
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("00000000-0000-4000-8000-0000000000e1"),
    requestNamespace: "mcp-tool-use-eval",
    thread: {
      threadId: THREAD,
      providerSessionId: "mcp-tool-use-eval",
      // The testkit's live thread runs on the `codex` instance; the caller must match it.
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set<McpInvocationContext.McpCapability>(
      world.machineAgentAccess === true ? ["machines"] : [],
    ),
    issuedAt: 0,
  };
  const client = McpSchema.McpServerClient.of({
    clientId: 0,
    clientCapabilities: {},
    clientInfo: { name: "mcp-tool-use-eval", version: "1.0.0" },
    protocolVersion: "2025-06-18",
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-tool-use-eval", version: "1.0.0" },
    },
    getClient: Effect.die("unused"),
  });
  const call = Effect.fn("evaluateMcpToolUse.machineCall")(function* (
    name: string,
    input: unknown,
  ) {
    const result = yield* server
      .callTool({ name, arguments: input as Record<string, unknown> })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        // An MCP client shows a protocol error, such as bad parameters, as the tool's error.
        Effect.catch((error) =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              isError: true,
              content: [{ type: "text", text: error.message }],
            }),
          ),
        ),
      );
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { text, isError: result.isError === true };
  });
  /** Machines the sample still holds, for the shell simulator. */
  const describe = () =>
    machines.size === 0
      ? []
      : [
          `T3 machines this project holds, all running Ubuntu with passwordless sudo for ubuntu: ${[
            ...machines.values(),
          ]
            .map((machine) => `${machine.name} (${machine.type}, ${machine.addresses[0]})`)
            .join(
              ", ",
            )}. \`ssh -F ${SSH_CONFIG} <name> '<command>'\` runs the command on that machine, not this one.`,
        ];
  return { call, describe };
});

export type MachineTools = Effect.Success<ReturnType<typeof makeMachineTools>>;
