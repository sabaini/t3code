import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const MachineHostId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
);
export type MachineHostId = typeof MachineHostId.Type;

/**
 * An LXD server joined with a trust token. The client certificate is
 * restricted to `project`, and `serverCertificate` is pinned: the server is
 * known by it, not by its address.
 */
export const MachineHostConfig = Schema.Struct({
  id: MachineHostId,
  label: TrimmedNonEmptyString,
  /** `host:port`, with IPv6 hosts in brackets, as LXD lists it in trust tokens. */
  address: TrimmedNonEmptyString,
  serverCertificate: TrimmedNonEmptyString,
  project: TrimmedNonEmptyString,
  clientCertificate: TrimmedNonEmptyString,
  /**
   * Kept in the secret store. This is `secretSetting` from settings.ts, which
   * imports this module.
   */
  clientKey: TrimmedString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
});
export type MachineHostConfig = typeof MachineHostConfig.Type;

export const MachineHostConfigs = Schema.Array(MachineHostConfig).check(
  Schema.makeFilter(
    (hosts: ReadonlyArray<{ readonly id: string }>) =>
      new Set(hosts.map((host) => host.id)).size === hosts.length ||
      "Machine host ids must be unique.",
  ),
);

export const MachineType = Schema.Literals(["virtual-machine", "container"]);
export type MachineType = typeof MachineType.Type;

export const MachineProfileName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,30}$/),
);

/**
 * `ubuntu:` and `ubuntu-daily:` are Canonical's simplestreams servers; a bare alias is an image
 * on the LXD server. Machines log in as `ubuntu` and relay ssh through OpenBSD `nc -N`, which
 * only Ubuntu images promise, so the `images:` server's other distributions are left out.
 */
export const MachineImage = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:(?:ubuntu|ubuntu-daily):)?[A-Za-z0-9][A-Za-z0-9._/-]*$/),
);

export const MachineProfile = Schema.Struct({
  name: MachineProfileName,
  image: MachineImage,
  type: MachineType,
  /** Profiles on the LXD server, applied in order. Their root disk's pool also holds extra disks. */
  lxdProfiles: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(["default"])),
  ),
  cpus: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
  memoryGiB: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
  /** Extra raw block disks, each its own volume. */
  diskSizesGiB: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })))
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  lifetimeHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(24)),
  ),
}).check(
  // LXD attaches custom block volumes only to virtual machines.
  Schema.makeFilter(
    (profile: { readonly type: MachineType; readonly diskSizesGiB: ReadonlyArray<number> }) =>
      profile.type === "virtual-machine" ||
      profile.diskSizesGiB.length === 0 ||
      "Only virtual machines can have extra disks.",
  ),
);
export type MachineProfile = typeof MachineProfile.Type;

export const MachineProfiles = Schema.Array(MachineProfile).check(
  Schema.makeFilter(
    (profiles: ReadonlyArray<{ readonly name: string }>) =>
      new Set(profiles.map((profile) => profile.name)).size === profiles.length ||
      "Machine profile names must be unique.",
  ),
);

export const MachineName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/),
  // `ssh <name>` must not shadow the environment's own host.
  Schema.makeFilter((name) => name !== "localhost" || "A machine can't be called localhost."),
);
export type MachineName = typeof MachineName.Type;

export const MachineState = Schema.Literals([
  "creating",
  "starting",
  "ready",
  "stopped",
  "releasing",
  "failed",
  "missing",
  "disconnected",
]);
export type MachineState = typeof MachineState.Type;

export const MachineView = Schema.Struct({
  name: MachineName,
  profile: Schema.String,
  type: MachineType,
  image: Schema.String,
  cpus: Schema.Int,
  memoryGiB: Schema.Int,
  diskSizesGiB: Schema.Array(Schema.Int),
  state: MachineState,
  hostLabel: Schema.String,
  /** The name the thread's other machines reach it by. */
  dnsName: Schema.String,
  /** Where the thread's other machines reach it, while it runs. */
  addresses: Schema.Array(Schema.String),
  expiresAt: IsoDateTime,
  sshCommand: Schema.String,
  error: Schema.optional(Schema.String),
});
export type MachineView = typeof MachineView.Type;

export class MachineToolError extends Schema.TaggedError<MachineToolError>()("MachineToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const MachineToolAcquireInput = Schema.Struct({
  profile: MachineProfileName.annotate({
    description: "A machine profile from machine_list.",
  }),
  name: Schema.optional(
    MachineName.annotate({
      description:
        "The machine's ssh host name in this thread. Defaults to the profile name and a number, such as vm-1.",
    }),
  ),
});
export type MachineToolAcquireInput = typeof MachineToolAcquireInput.Type;

export const MachineToolNameInput = Schema.Struct({
  name: MachineName.annotate({ description: "The machine's name from machine_list." }),
});
export type MachineToolNameInput = typeof MachineToolNameInput.Type;

export const MachineToolListInput = Schema.Struct({
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  name: Schema.optional(
    MachineName.annotate({ description: "Limit to one machine. Defaults to all of them." }),
  ),
});
export type MachineToolListInput = typeof MachineToolListInput.Type;

export const MachineToolMachineResult = Schema.Struct({
  machine: MachineView,
  /** What to do next: ssh in, wait longer, or why it failed. */
  next: Schema.String,
});
export type MachineToolMachineResult = typeof MachineToolMachineResult.Type;

export const MachineToolListResult = Schema.Struct({
  machines: Schema.Array(MachineView),
  profiles: Schema.Array(MachineProfile),
  /** Pass it to ssh, scp or rsync with `-F`; it exists before the first machine does. */
  sshConfig: Schema.String,
  /** Set when this thread's agent runs in a sandbox that blocks ssh to machines. */
  notice: Schema.optional(Schema.String),
});
export type MachineToolListResult = typeof MachineToolListResult.Type;

/** What clients get when a machine operation fails; the message says why in words for the user. */
export class MachineRpcError extends Schema.TaggedError<MachineRpcError>()("MachineRpcError", {
  message: Schema.String,
}) {}

export const MachineThreadInput = Schema.Struct({ threadId: ThreadId });
export type MachineThreadInput = typeof MachineThreadInput.Type;

export const MachineThreadState = Schema.Struct({ machines: Schema.Array(MachineView) });
export type MachineThreadState = typeof MachineThreadState.Type;

export const MachineReleaseInput = Schema.Struct({ threadId: ThreadId, name: MachineName });
export type MachineReleaseInput = typeof MachineReleaseInput.Type;

export const MachineHostConnectInput = Schema.Struct({
  trustToken: TrimmedNonEmptyString,
  /** Defaults to the LXD server's name. */
  label: Schema.optional(TrimmedString),
});
export type MachineHostConnectInput = typeof MachineHostConnectInput.Type;

export const MachineHostConnectResult = Schema.Struct({
  hostId: MachineHostId,
  label: Schema.String,
});
export type MachineHostConnectResult = typeof MachineHostConnectResult.Type;

export const MachineHostInput = Schema.Struct({ hostId: MachineHostId });
export type MachineHostInput = typeof MachineHostInput.Type;

export const MachineHostDisconnectResult = Schema.Struct({
  /** Set when the server didn't answer: run it there to remove T3 Code's certificate. */
  manualCommand: Schema.optional(Schema.String),
});
export type MachineHostDisconnectResult = typeof MachineHostDisconnectResult.Type;

export const MachineHostStatus = Schema.Struct({
  serverName: Schema.String,
  version: Schema.String,
  versionSupported: Schema.Boolean,
  instanceTypes: Schema.Array(Schema.String),
  /** The OVN uplink thread networks use, when the project allows exactly one. */
  uplink: Schema.optional(Schema.String),
  /** Project settings machines need, as `key=value`. */
  missing: Schema.Array(Schema.String),
  /** Project settings that would hand machines the LXD server. */
  unsafe: Schema.Array(Schema.String),
});
export type MachineHostStatus = typeof MachineHostStatus.Type;

export const MachineHostInspection = Schema.Struct({
  hostId: MachineHostId,
  status: Schema.optional(MachineHostStatus),
  error: Schema.optional(Schema.String),
});
export type MachineHostInspection = typeof MachineHostInspection.Type;

/** An instance this environment made whose machine it no longer knows, such as after its state was reset. */
export const UntrackedMachine = Schema.Struct({
  hostId: MachineHostId,
  instance: Schema.String,
  type: Schema.String,
  status: Schema.String,
  threadId: Schema.optional(Schema.String),
});
export type UntrackedMachine = typeof UntrackedMachine.Type;

export const MachineHostsInspection = Schema.Struct({
  hosts: Schema.Array(MachineHostInspection),
  untracked: Schema.Array(UntrackedMachine),
});
export type MachineHostsInspection = typeof MachineHostsInspection.Type;

export const UntrackedMachineInput = Schema.Struct({
  hostId: MachineHostId,
  instance: TrimmedNonEmptyString,
});
export type UntrackedMachineInput = typeof UntrackedMachineInput.Type;
