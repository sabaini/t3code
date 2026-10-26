import {
  MachineToolError,
  type MachineView,
  type ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MachineService from "../../../machines/MachineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachineToolkit } from "./tools.ts";

/** Under the 60 seconds Codex gives an MCP call by default. */
const TOOL_WAIT = "40 seconds";

/**
 * ssh reaches a machine through a Unix socket that T3 Code serves. Outside
 * full access, Codex's and Cursor's sandboxes refuse to connect to it; on
 * Linux Codex has no setting that allows Unix sockets without opening the
 * network too.
 */
function machineSandboxNotice(
  driver: ProviderDriverKind | undefined,
  runtimeMode: RuntimeMode,
): string | undefined {
  if (runtimeMode === "full-access") return undefined;
  if (driver === "codex") {
    return 'Your sandbox blocks ssh\'s connection to T3 Code, so ssh to machines fails with "Operation not permitted". Run ssh, scp and rsync to machines with escalated permissions, outside the sandbox, or ask the user to switch this thread to Full access.';
  }
  if (driver === "cursor") {
    return "Your sandbox blocks ssh's connection to T3 Code, so ssh to machines fails. Ask the user to switch this thread to Full access.";
  }
  return undefined;
}

function machineNext(machine: MachineView, sshConfig: string, notice: string | undefined): string {
  const { name } = machine;
  const lines = ((): ReadonlyArray<string> => {
    switch (machine.state) {
      case "ready":
        return [
          `Run commands on ${name} with: ${machine.sshCommand} '<command>'`,
          `Use this exact -F config: it routes ssh through T3 Code and pins the machine's host key. Copy files with scp -F ${sshConfig}, or rsync -e 'ssh -F ${sshConfig}'.`,
          "You log in as ubuntu, with passwordless sudo.",
          `The thread's other machines reach it as ${machine.dnsName}. It can reach the internet, but not the user's network.`,
          `It stops while this thread is idle, and ssh starts it again. It's deleted at ${machine.expiresAt}; release it with machine_release once you're done.`,
        ];
      case "creating":
      case "starting":
        return [
          `${name} is still ${machine.state}. Call machine_wait with name "${name}"; each call waits up to 40 seconds. A new image can take a few minutes to download.`,
        ];
      case "stopped":
        return [
          `${name} is stopped. ssh starts it again, or call machine_wait with name "${name}".`,
        ];
      case "failed":
        return [
          `${name} failed: ${machine.error ?? "unknown error"}`,
          "Release it with machine_release, then acquire another.",
        ];
      case "missing":
        return [`${name} is gone from its LXD server. Release it with machine_release.`];
      case "disconnected":
        return [
          `${name}'s LXD server isn't connected. Ask the user to reconnect ${machine.hostLabel} in Settings → Devices → Machines.`,
        ];
      case "releasing":
        return [`${name} is being released.`];
    }
  })();
  return [...lines, ...(notice === undefined ? [] : [notice])].join("\n");
}

const requireMachineAccess = McpInvocationContext.requireThreadMcpCapability("machines").pipe(
  Effect.mapError(
    () =>
      new MachineToolError({
        reason:
          "Agent machine access is off for this project. Ask the user to turn on Agent machine access in Settings → Devices → Machines, for this project or all of them.",
      }),
  ),
);

const sandboxNotice = Effect.fn("MachineTools.sandboxNotice")(function* (
  thread: McpInvocationContext.McpThreadCaller,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const shell = yield* threads
    .getThreadShell(thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null) return undefined;
  const providers = yield* registry.getProviders;
  const driver = providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  )?.driver;
  return machineSandboxNotice(driver, shell.runtimeMode);
});

const toolError = (error: MachineService.MachineError | MachineToolError) =>
  error._tag === "MachineToolError" ? error : new MachineToolError({ reason: error.message });

const machineResult = Effect.fn("MachineTools.machineResult")(function* (
  thread: McpInvocationContext.McpThreadCaller,
  machine: MachineView,
) {
  const machines = yield* MachineService.MachineService;
  const notice = yield* sandboxNotice(thread);
  return {
    machine,
    next: machineNext(machine, machines.sshConfigPath(thread.threadId), notice),
  };
});

const handlers = {
  machine_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const machines = yield* MachineService.MachineService;
      const all = yield* machines.list(thread.threadId);
      const notice = yield* sandboxNotice(thread);
      return {
        machines:
          input.name === undefined ? all : all.filter((machine) => machine.name === input.name),
        profiles: yield* machines.profiles(thread.threadId),
        sshConfig: machines.sshConfigPath(thread.threadId),
        ...(notice === undefined ? {} : { notice }),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_acquire: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const machines = yield* MachineService.MachineService;
      const machine = yield* machines.acquire({
        threadId: thread.threadId,
        profile: input.profile,
        name: input.name,
        waitFor: TOOL_WAIT,
      });
      return yield* machineResult(thread, machine);
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_wait: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const machines = yield* MachineService.MachineService;
      const machine = yield* machines.wait({
        threadId: thread.threadId,
        name: input.name,
        waitFor: TOOL_WAIT,
      });
      return yield* machineResult(thread, machine);
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const machines = yield* MachineService.MachineService;
      yield* machines.release({ threadId: thread.threadId, name: input.name });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof MachineToolkit.tools>;

export const layer = McpToolAccess.toLayer(MachineToolkit, handlers);
