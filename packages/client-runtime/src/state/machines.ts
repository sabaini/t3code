import {
  type EnvironmentId,
  type MachineState,
  type MachineView,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMachineEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const hosts = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:machines:hosts",
    tag: WS_METHODS.machinesInspectHosts,
  });
  // Connecting, disconnecting or deleting changes what inspecting the servers shows.
  const refreshHosts = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(hosts({ environmentId: target.environmentId, input: {} })));
  return {
    project: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:machines:project",
      tag: WS_METHODS.machinesSubscribeProject,
    }),
    hosts,
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:release",
      tag: WS_METHODS.machinesRelease,
    }),
    connectHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:connect-host",
      tag: WS_METHODS.machinesConnectHost,
      onSuccess: refreshHosts,
    }),
    disconnectHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:disconnect-host",
      tag: WS_METHODS.machinesDisconnectHost,
      onSuccess: refreshHosts,
    }),
    deleteUntracked: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:machines:delete-untracked",
      tag: WS_METHODS.machinesDeleteUntracked,
      onSuccess: refreshHosts,
    }),
  };
}

const MACHINE_STATE_LABELS = {
  creating: "Creating",
  starting: "Starting",
  ready: "Running",
  stopped: "Stopped",
  releasing: "Releasing",
  failed: "Failed",
  missing: "Gone from its LXD server",
  disconnected: "LXD server not connected",
} satisfies Record<MachineState, string>;

export const machineStateLabel = (state: MachineState) => MACHINE_STATE_LABELS[state];

/** Whether the state is a problem the user may need to act on. */
export const machineStateIsProblem = (state: MachineState) =>
  state === "failed" || state === "missing" || state === "disconnected";

/** Like "VM · 2 CPUs · 4 GiB · 2 disks". */
export function machineSpecLabel(machine: MachineView): string {
  const disks = machine.diskSizesGiB.length;
  return [
    machine.type === "virtual-machine" ? "VM" : "Container",
    `${machine.cpus} ${machine.cpus === 1 ? "CPU" : "CPUs"}`,
    `${machine.memoryGiB} GiB`,
    ...(disks === 0 ? [] : [`${disks} ${disks === 1 ? "disk" : "disks"}`]),
  ].join(" · ");
}

/** Like "Deleted in 23h", from the machine's `expiresAt`. */
export function machineDeletionLabel(expiresAt: string, now: number): string {
  const minutes = Math.floor((Date.parse(expiresAt) - now) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "Deleted soon";
  if (minutes < 60) return `Deleted in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Deleted in ${hours}h`;
  return `Deleted in ${Math.floor(hours / 24)}d`;
}
