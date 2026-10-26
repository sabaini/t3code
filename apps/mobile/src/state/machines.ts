import { useAtomValue } from "@effect/atom-react";
import { createMachineEnvironmentAtoms } from "@t3tools/client-runtime/state/machines";
import type { EnvironmentId, MachineView, ServerSettings, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

export const machineEnvironment = createMachineEnvironmentAtoms(connectionAtomRuntime);

const NO_MACHINES: ReadonlyArray<MachineView> = [];
const selectHasMachineHosts = (settings: ServerSettings | null | undefined) =>
  (settings?.machineHosts.length ?? 0) > 0;

/** Subscribes only where an LXD server is connected, so other environments pay nothing. */
export function useThreadMachines(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<MachineView> {
  const hasHosts = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    selectHasMachineHosts,
  );
  const query = useEnvironmentQuery(
    hasHosts ? machineEnvironment.thread({ environmentId, input: { threadId } }) : null,
  );
  return query.data?.machines ?? NO_MACHINES;
}
