import type {
  MachineHostConfig,
  MachineProfile,
  ProjectId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class MachinePlatformError extends Schema.TaggedError<MachinePlatformError>()(
  "MachinePlatformError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't ${this.operation}.`;
  }
}

/**
 * What machines need from the application that runs them. T3 Code's server
 * provides it from its settings, secret store and projects.
 */
export class MachinePlatform extends Context.Service<
  MachinePlatform,
  {
    /** Tags instances, so environments that share an LXD project leave each other's machines alone. */
    readonly environmentId: Effect.Effect<string>;
    /** Machines keep their SSH key, configs and relay sockets below it. */
    readonly stateDir: string;
    /** LXD servers, with their client keys. */
    readonly hosts: Effect.Effect<ReadonlyArray<MachineHostConfig>, ServerSettingsError>;
    readonly setHosts: (
      hosts: ReadonlyArray<MachineHostConfig>,
    ) => Effect.Effect<void, ServerSettingsError>;
    /** The LXD servers again after each settings change. */
    readonly hostChanges: Stream.Stream<ReadonlyArray<MachineHostConfig>>;
    readonly profiles: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<MachineProfile>, ServerSettingsError>;
    /** False once the project is deleted, which releases its machines. */
    readonly projectExists: (projectId: ProjectId) => Effect.Effect<boolean, MachinePlatformError>;
    /** Runs `ssh-keygen` and `openssl`. */
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly code: number | null; readonly stdout: string; readonly stderr: string },
      MachinePlatformError
    >;
  }
>()("t3/machines/MachinePlatform") {}
