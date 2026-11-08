import {
  MachineToolError,
  type MachineView,
  type ProviderDriverKind,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MachineService from "@t3tools/machines/MachineService";
import { shellWord } from "@t3tools/machines/MachineSsh";
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

function machineNext(
  machine: MachineView,
  caller: ThreadId,
  sshConfig: string,
  notice: string | undefined,
): string {
  const { name } = machine;
  const release =
    machine.threadId === caller
      ? "release it with machine_release once you're done, unless the user wants to keep it."
      : "another thread made it and may still use it, so release it only if the user asks.";
  const lines = ((): ReadonlyArray<string> => {
    switch (machine.state) {
      case "ready":
        return [
          `Run commands on ${name} with: ${machine.sshCommand} '<command>'`,
          `Use this exact -F config: it routes ssh through T3 Code and pins the machine's host key. Copy files with scp -F ${shellWord(sshConfig)}, or rsync -e ${shellWord(`ssh -F ${shellWord(sshConfig)}`)}.`,
          "You log in as ubuntu, with passwordless sudo.",
          `The project's other machines reach it as ${machine.dnsName}. It can reach the internet, but not the user's network.`,
          `It belongs to the project, so other threads can use it too. It stops after 4 hours without use, and ssh starts it again. It's deleted at ${machine.expiresAt}; ${release}`,
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

/** Machines belong to the calling thread's project. */
const callerOf = Effect.fn("MachineTools.callerOf")(function* (
  thread: McpInvocationContext.McpThreadCaller,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const shell = yield* threads
    .getThreadShell(thread.threadId)
    .pipe(Effect.mapError((error) => new MachineToolError({ reason: error.message })));
  if (shell === null) {
    return yield* new MachineToolError({ reason: "This thread no longer exists." });
  }
  const providers = yield* registry.getProviders;
  const driver = providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  )?.driver;
  return {
    threadId: thread.threadId,
    projectId: shell.projectId,
    notice: machineSandboxNotice(driver, shell.runtimeMode),
  };
});
type Caller = Effect.Success<ReturnType<typeof callerOf>>;

const toolError = (error: MachineService.MachineError | MachineToolError) =>
  error._tag === "MachineToolError" ? error : new MachineToolError({ reason: error.message });

const machineResult = Effect.fn("MachineTools.machineResult")(function* (
  caller: Caller,
  machine: MachineView,
) {
  const machines = yield* MachineService.MachineService;
  return {
    machine,
    next: machineNext(
      machine,
      caller.threadId,
      machines.sshConfigPath(caller.projectId),
      caller.notice,
    ),
  };
});

const handlers = {
  machine_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const caller = yield* callerOf(thread);
      const machines = yield* MachineService.MachineService;
      const all = yield* machines.list(caller.projectId);
      return {
        machines:
          input.name === undefined ? all : all.filter((machine) => machine.name === input.name),
        profiles: yield* machines.profiles(caller.projectId),
        sshConfig: machines.sshConfigPath(caller.projectId),
        threadId: caller.threadId,
        ...(caller.notice === undefined ? {} : { notice: caller.notice }),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_acquire: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const caller = yield* callerOf(thread);
      const machines = yield* MachineService.MachineService;
      const machine = yield* machines.acquire({
        projectId: caller.projectId,
        threadId: caller.threadId,
        profile: input.profile,
        name: input.name,
        waitFor: TOOL_WAIT,
      });
      return yield* machineResult(caller, machine);
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_wait: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const caller = yield* callerOf(thread);
      const machines = yield* MachineService.MachineService;
      const machine = yield* machines.wait({
        projectId: caller.projectId,
        name: input.name,
        waitFor: TOOL_WAIT,
      });
      return yield* machineResult(caller, machine);
    }).pipe(Effect.mapError(toolError)),
  ),
  machine_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* requireMachineAccess;
      const caller = yield* callerOf(thread);
      const machines = yield* MachineService.MachineService;
      yield* machines.release({ projectId: caller.projectId, name: input.name });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof MachineToolkit.tools>;

export const layer = McpToolAccess.toLayer(MachineToolkit, handlers);
