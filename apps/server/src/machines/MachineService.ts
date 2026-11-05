// @effect-diagnostics nodeBuiltinImport:off - Synchronous hashing and the temp directory for path names; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  type MachineHostConfig,
  type MachineHostInspection,
  type MachineProfile,
  type MachineState,
  type MachineView,
  ProjectId,
  ServerSettingsError,
  type ThreadId,
  type UntrackedMachine,
  type UntrackedMachineInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { LxdClient, LxdError, LxdNetworkAcl, LxdNetworkAclPut } from "./lxd/LxdClient.ts";
import * as MachineHosts from "./MachineHosts.ts";
import * as MachineLeaseStore from "./MachineLeaseStore.ts";
import { MachinePlatform, type MachinePlatformError } from "./MachinePlatform.ts";
import {
  lxdVersionSupported,
  MACHINE_DNS_DOMAIN,
  MACHINE_NETWORK_ACL,
  machineImageSource,
  machineInstanceConfig,
  machineInstanceName,
  machineInstanceTags,
  machineNetworkAclRules,
  PROJECT_NETWORK_SECURITY,
  projectNetworkName,
  projectSandbox,
} from "./MachineSandbox.ts";
import {
  ensureMachineSshKey,
  MACHINE_SSH_RELAY_COMMAND,
  machineSshConfig,
  MachineSshError,
  relaySshConnection,
  serveRelaySocket,
  writeMachineSshProxy,
} from "./MachineSsh.ts";

export const MAX_MACHINES_PER_PROJECT = 5;
const BOOT_TIMEOUT = Duration.minutes(10);
const BOOT_POLL_INTERVAL = Duration.seconds(3);
/** A VM's files come through its LXD agent, which may hang while the VM boots. */
const PROBE_TIMEOUT = Duration.seconds(15);
const SWEEP_INTERVAL = Duration.minutes(5);
const IDLE_STOP_AFTER = Duration.hours(4);
/** A host that doesn't answer doesn't hold up placing a machine on another. */
const PLACEMENT_TIMEOUT = Duration.seconds(5);
/**
 * cloud-init writes this on tmpfs once it has finished the current boot. Its
 * boot-finished file can't tell: it stays on disk from the previous boot.
 */
const CLOUD_INIT_RESULT_PATH = "/run/cloud-init/result.json";
const HOST_KEY_PATHS = ["ed25519", "ecdsa", "rsa"].map(
  (type) => `/etc/ssh/ssh_host_${type}_key.pub`,
);
/** How long inspecting one LXD server may take before Settings shows it as unreachable. */
const INSPECT_TIMEOUT = Duration.seconds(10);
/** Unix socket paths are limited to 107 bytes. */
const MAX_SOCKET_PATH = 100;

export class MachineRefusedError extends Schema.TaggedError<MachineRefusedError>()(
  "MachineRefusedError",
  {
    reason: Schema.Literals([
      "not-found",
      "no-hosts",
      "no-profiles",
      "unknown-profile",
      "limit",
      "name-taken",
      "host-disconnected",
      "unsupported-version",
      "no-virtual-machines",
      "no-containers",
      "unsandboxed",
      "missing-lxd-profile",
      "extra-nic",
      "no-root-disk",
      "no-usable-host",
      "not-ready",
      "boot-timeout",
      "no-host-keys",
      "interrupted",
      "untracked-not-found",
    ]),
    subject: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    const subject = this.subject ?? "";
    switch (this.reason) {
      case "not-found":
        return `This project has no machine called ${subject}.`;
      case "no-hosts":
        return "No LXD server is connected, so there are no machines. Ask the user to connect one in Settings → Devices → Machines.";
      case "no-profiles":
        return "This project has no machine profiles. Ask the user to add one in Settings → Devices → Machines.";
      case "unknown-profile":
        return `There's no machine profile called ${subject}. This project has ${(this.options ?? []).join(", ")}.`;
      case "limit":
        return `This project already has ${MAX_MACHINES_PER_PROJECT} machines. Release one first.`;
      case "name-taken":
        return `This project already has a machine called ${subject}.`;
      case "host-disconnected":
        return `${subject} is on an LXD server that isn't connected now. It can be used or released once the user connects it again in Settings → Devices → Machines.`;
      case "unsupported-version":
        return `The LXD server runs LXD ${subject}, and machines need LXD 6.9 or later.`;
      case "no-virtual-machines":
        return "The LXD server can't run virtual machines: it has no hardware virtualization (/dev/kvm).";
      case "no-containers":
        return "The LXD server can't run containers.";
      case "unsandboxed":
        return `The LXD project ${subject} isn't set up to keep machines apart from the rest of the network, so T3 Code won't create them there. Ask the user to check Settings → Devices → Machines.`;
      case "missing-lxd-profile":
        return `The LXD server has no profile called ${subject}.`;
      case "extra-nic":
        return `The LXD profile ${subject} gives machines another network device, which could connect them to more than their project's other machines.`;
      case "no-root-disk":
        return "None of the profile's LXD profiles gives machines a root disk, so there's no storage pool for their extra disks.";
      case "no-usable-host":
        return `None of the connected LXD servers can take this machine. ${subject}`;
      case "not-ready":
        return `${subject} isn't ready.`;
      case "boot-timeout":
        return `${subject} didn't finish booting within 10 minutes. Its image may not have cloud-init.`;
      case "no-host-keys":
        return `${subject} has no SSH host keys. Its image needs openssh-server.`;
      case "interrupted":
        return "T3 Code restarted before this machine was created. Release it and acquire a new one.";
      case "untracked-not-found":
        return `There's no untracked machine called ${subject} on that LXD server.`;
    }
  }
}

export type MachineError =
  | MachineRefusedError
  | MachineLeaseStore.MachineLeaseStoreError
  | MachinePlatformError
  | MachineSshError
  | LxdError
  | ServerSettingsError;

type MachineLease = MachineLeaseStore.MachineLease;
type ConnectedHost = MachineHosts.ConnectedMachineHost;
type DeviceMap = Record<string, Readonly<Record<string, string>>>;

export class MachineService extends Context.Service<
  MachineService,
  {
    /**
     * Creates a machine from one of the project's profiles for `threadId`'s agent,
     * waiting up to `waitFor` for it to boot.
     */
    readonly acquire: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly profile: string;
      readonly name?: string | undefined;
      readonly waitFor?: Duration.Input | undefined;
    }) => Effect.Effect<MachineView, MachineError>;
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<MachineView>, MachineError>;
    readonly profiles: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<MachineProfile>, MachineError>;
    /** Starts the machine if it's stopped, and waits up to `waitFor` for it to boot. */
    readonly wait: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
      readonly waitFor?: Duration.Input | undefined;
    }) => Effect.Effect<MachineView, MachineError>;
    /** Deletes the machine and its disks; work still going on for it stops first. */
    readonly release: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
    }) => Effect.Effect<void, MachineError>;
    /** The project's machines, then again after each change T3 Code makes to them. */
    readonly subscribeProject: (
      projectId: ProjectId,
    ) => Stream.Stream<ReadonlyArray<MachineView>, MachineError>;
    /** Each LXD server's status, and the machines this environment made there that it no longer knows. */
    readonly inspectHosts: Effect.Effect<
      {
        readonly hosts: ReadonlyArray<MachineHostInspection>;
        readonly untracked: ReadonlyArray<UntrackedMachine>;
      },
      MachineError
    >;
    /** Deletes a machine `inspectHosts` lists as untracked, with its disks. */
    readonly deleteUntracked: (input: UntrackedMachineInput) => Effect.Effect<void, MachineError>;
    /** Known before any machine exists, so agents can be told up front. */
    readonly sshConfigPath: (projectId: ProjectId) => string;
    /** Expiry, idle stops, deleted projects, and work a restart or a disconnected host left unfinished. */
    readonly sweep: Effect.Effect<void>;
    /**
     * Restores relay sockets, then sweeps every few minutes and follows LXD
     * server changes until interrupted. The application forks it once it serves.
     */
    readonly run: Effect.Effect<void>;
  }
>()("t3/machines/MachineService") {}

const sha = (value: string, length: number) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, length);

const refused = (
  reason: MachineRefusedError["reason"],
  subject?: string,
  options?: ReadonlyArray<string>,
) =>
  new MachineRefusedError({
    reason,
    ...(subject === undefined ? {} : { subject }),
    ...(options === undefined ? {} : { options }),
  });

const sameAclRules = (current: LxdNetworkAcl, wanted: LxdNetworkAclPut) => {
  const normalize = (
    rules: ReadonlyArray<{
      readonly action?: string | undefined;
      readonly source?: string | undefined;
      readonly destination?: string | undefined;
      readonly state?: string | undefined;
    }>,
  ) =>
    rules.map((rule) =>
      [rule.action, rule.source ?? "", rule.destination ?? "", rule.state].join("\0"),
    );
  const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    same(normalize(current.egress), normalize(wanted.egress)) &&
    same(normalize(current.ingress), normalize(wanted.ingress))
  );
};

const make = Effect.gen(function* () {
  const platform = yield* MachinePlatform;
  const hosts = yield* MachineHosts.MachineHosts;
  const store = yield* MachineLeaseStore.MachineLeaseStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processContext = yield* Effect.context<
    MachinePlatform | FileSystem.FileSystem | Path.Path
  >();
  const layerScope = yield* Effect.scope;

  const projectLock = yield* KeyedLock.make<ProjectId>();
  const aclLock = yield* KeyedLock.make<string>();
  const sshLock = yield* KeyedLock.make<ProjectId>();
  const sweepLock = yield* Semaphore.make(1);
  const keyLock = yield* Semaphore.make(1);
  /** Creating or booting a machine, by lease id. */
  const tasks = yield* FiberMap.make<string, void, never>();
  /** Relay sockets by project, then machine name. */
  const relays = new Map<ProjectId, Map<string, Scope.Closeable>>();
  /** Open SSH connections by lease id; a machine in use isn't stopped for being idle. */
  const openConnections = new Map<string, number>();
  /** Projects whose machines changed. */
  const changed = yield* PubSub.unbounded<ProjectId>();
  const notify = (projectId: ProjectId) => PubSub.publish(changed, projectId);

  const machinesDir = path.join(platform.stateDir, "machines");
  const keyDir = path.join(machinesDir, "ssh");
  const proxyPath = path.join(keyDir, "proxy");
  // Deep state directories, like a worktree's, would make relay socket paths too long.
  const projectsDir =
    path.join(machinesDir, "p").length + 1 + 12 + 1 + 17 <= MAX_SOCKET_PATH
      ? path.join(machinesDir, "p")
      : path.join(NodeOS.tmpdir(), `t3m-${sha(platform.stateDir, 8)}`);
  const projectDir = (projectId: ProjectId) => path.join(projectsDir, sha(projectId, 12));
  const sshConfigPath = (projectId: ProjectId) => path.join(projectDir(projectId), "ssh_config");
  const socketPath = (projectId: ProjectId, name: string) =>
    path.join(projectDir(projectId), `${sha(name, 12)}.sock`);

  let sshKey: { readonly keyPath: string; readonly publicKey: string } | undefined;
  const ensureSshKey = Effect.gen(function* () {
    if (sshKey) return sshKey;
    const key = yield* ensureMachineSshKey(keyDir);
    yield* writeMachineSshProxy(proxyPath);
    sshKey = key;
    return key;
  }).pipe(keyLock.withPermits(1), Effect.provideContext(processContext));

  const now = Clock.currentTimeMillis;

  const leasesOf = (projectId: ProjectId) => store.listForProject(projectId);

  const findLease = Effect.fn("MachineService.findLease")(function* (
    projectId: ProjectId,
    name: string,
  ) {
    const lease = (yield* leasesOf(projectId)).find((candidate) => candidate.name === name);
    if (!lease) return yield* refused("not-found", name);
    return lease;
  });

  /** Re-reads the lease, so concurrent changes to other fields aren't lost. */
  const updateLease = Effect.fn("MachineService.updateLease")(function* (
    lease: MachineLease,
    change: (current: MachineLease) => MachineLease,
  ) {
    return yield* projectLock.withLock(
      lease.projectId,
      Effect.gen(function* () {
        const current = (yield* leasesOf(lease.projectId)).find(
          (candidate) => candidate.leaseId === lease.leaseId,
        );
        if (!current) return Option.none<MachineLease>();
        const next = change(current);
        yield* store.save(next);
        yield* notify(lease.projectId);
        return Option.some(next);
      }),
    );
  });

  const hostOf = (connected: ReadonlyArray<ConnectedHost>, lease: MachineLease) =>
    connected.find((entry) => entry.host.id === lease.hostId);

  const connectedHostOf = Effect.fn("MachineService.connectedHostOf")(function* (
    lease: MachineLease,
  ) {
    const host = hostOf(yield* hosts.connected, lease);
    if (!host) return yield* refused("host-disconnected", lease.name);
    return host;
  });

  const syncProjectSsh = Effect.fn("MachineService.syncProjectSsh")(function* (
    projectId: ProjectId,
  ) {
    yield* sshLock.withLock(
      projectId,
      Effect.gen(function* () {
        const leases = yield* leasesOf(projectId);
        const reachable = leases.filter(
          (lease) => lease.hostKeys.length > 0 && lease.status !== "releasing",
        );
        const current = relays.get(projectId) ?? new Map<string, Scope.Closeable>();
        relays.set(projectId, current);
        for (const [name, scope] of current) {
          if (reachable.some((lease) => lease.name === name)) continue;
          current.delete(name);
          yield* Scope.close(scope, Exit.void);
        }
        const directory = projectDir(projectId);
        if (leases.length === 0) {
          relays.delete(projectId);
          yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
          return;
        }
        const failed = (cause: unknown) =>
          new MachineSshError({ operation: "write a project's SSH files", cause });
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(failed));
        for (const lease of reachable) {
          if (current.has(lease.name)) continue;
          const scope = yield* Scope.fork(layerScope);
          const exit = yield* serveRelaySocket(
            socketPath(projectId, lease.name),
            relayConnection(projectId, lease.name),
          ).pipe(Scope.provide(scope), Effect.provideContext(processContext), Effect.exit);
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, Exit.void);
            return yield* Effect.failCause(exit.cause);
          }
          current.set(lease.name, scope);
        }
        const key = yield* ensureSshKey;
        const knownHostsPath = path.join(directory, "known_hosts");
        yield* fs
          .writeFileString(
            knownHostsPath,
            reachable
              .flatMap((lease) => lease.hostKeys.map((hostKey) => `${lease.name} ${hostKey}\n`))
              .join(""),
            { mode: 0o600 },
          )
          .pipe(Effect.mapError(failed));
        yield* fs
          .writeFileString(
            sshConfigPath(projectId),
            machineSshConfig({
              machines: reachable.map((lease) => ({
                name: lease.name,
                socketPath: socketPath(projectId, lease.name),
              })),
              keyPath: key.keyPath,
              knownHostsPath,
              proxyPath,
            }),
            { mode: 0o600 },
          )
          .pipe(Effect.mapError(failed));
      }),
    );
  });

  /** The devices a machine's LXD profiles give it: a later profile's device replaces an earlier one's. */
  const profileDevices = Effect.fn("MachineService.profileDevices")(function* (
    lxd: LxdClient,
    profiles: ReadonlyArray<string>,
  ) {
    const devices = new Map<
      string,
      { readonly profile: string; readonly device: Readonly<Record<string, string>> }
    >();
    for (const profile of profiles) {
      const own = yield* lxd.profileDevices(profile);
      if (Option.isNone(own)) return yield* refused("missing-lxd-profile", profile);
      for (const [name, device] of Object.entries(own.value))
        devices.set(name, { profile, device });
    }
    return devices;
  });

  /** Refuses a host that can't run `profile`, or keep it sandboxed. Returns the uplink for project networks. */
  const checkHost = Effect.fn("MachineService.checkHost")(function* (
    entry: ConnectedHost,
    profile: MachineProfile,
  ) {
    const server = yield* entry.lxd.server;
    if (!lxdVersionSupported(server.version)) {
      return yield* refused("unsupported-version", server.version);
    }
    if (!server.instanceTypes.includes(profile.type)) {
      return yield* refused(
        profile.type === "virtual-machine" ? "no-virtual-machines" : "no-containers",
      );
    }
    const sandbox = projectSandbox(yield* entry.lxd.projectConfig(entry.host.project));
    if (!sandbox.uplink || sandbox.missing.length > 0 || sandbox.unsafe.length > 0) {
      return yield* refused("unsandboxed", entry.host.project);
    }
    // The machine's own eth0 replaces any its profiles have, but another NIC would get past the project's network.
    const devices = yield* profileDevices(entry.lxd, profile.lxdProfiles);
    for (const [name, { profile: lxdProfile, device }] of devices) {
      if (name !== "eth0" && device.type === "nic") {
        return yield* refused("extra-nic", lxdProfile);
      }
    }
    return { uplink: sandbox.uplink, devices };
  });

  /**
   * A project's machines reach each other on its network, which is on one host,
   * so they all go where its first one did. That one goes to the host with the
   * fewest instances among those that can take it.
   */
  const placement = Effect.fn("MachineService.placement")(function* (
    connected: ReadonlyArray<ConnectedHost>,
    leases: ReadonlyArray<MachineLease>,
    profile: MachineProfile,
  ) {
    const home = connected.find((entry) => leases.some((lease) => lease.hostId === entry.host.id));
    const only = home ?? (connected.length === 1 ? connected[0] : undefined);
    if (only) return { entry: only, ...(yield* checkHost(only, profile)) };
    const checked = yield* Effect.forEach(
      connected,
      (entry) =>
        Effect.all([checkHost(entry, profile), entry.lxd.instances]).pipe(
          Effect.timeout(PLACEMENT_TIMEOUT),
          Effect.map(([checks, instances]) => ({ entry, ...checks, load: instances.length })),
          Effect.result,
        ),
      { concurrency: "unbounded" },
    );
    const usable = checked.filter(Result.isSuccess).map((result) => result.success);
    if (usable.length === 0) {
      const reasons = checked.flatMap((result, index) =>
        Result.isFailure(result)
          ? [`${connected[index]?.host.label}: ${result.failure.message}`]
          : [],
      );
      return yield* refused("no-usable-host", reasons.join(" "));
    }
    return usable.reduce((fewest, candidate) =>
      candidate.load < fewest.load ? candidate : fewest,
    );
  });

  /** Keeps the shared ACL as the policy says, also when that changed or someone edited it. */
  const applyNetworkAcl = Effect.fn("MachineService.applyNetworkAcl")(function* (
    entry: ConnectedHost,
  ) {
    const rules = machineNetworkAclRules();
    const current = yield* entry.lxd.networkAcl(MACHINE_NETWORK_ACL);
    if (Option.isNone(current)) yield* entry.lxd.createNetworkAcl(MACHINE_NETWORK_ACL, rules);
    else if (!sameAclRules(current.value, rules)) {
      yield* entry.lxd.updateNetworkAcl(MACHINE_NETWORK_ACL, rules);
    }
  });

  const ensureProjectNetwork = Effect.fn("MachineService.ensureProjectNetwork")(function* (
    entry: ConnectedHost,
    projectId: ProjectId,
    uplink: string,
  ) {
    const name = projectNetworkName(projectId);
    const existing = yield* entry.lxd.network(name);
    if (Option.isNone(existing)) {
      yield* entry.lxd.createNetwork({
        name,
        description: `T3 Code machines of project ${projectId}`,
        config: { network: uplink, ...PROJECT_NETWORK_SECURITY },
      });
    } else if (
      Object.entries(PROJECT_NETWORK_SECURITY).some(
        ([key, value]) => existing.value.config[key] !== value,
      )
    ) {
      yield* entry.lxd.updateNetwork(name, PROJECT_NETWORK_SECURITY);
    }
  });

  /**
   * Projects without machines hold no uplink address. Machines T3 Code lost track of may still use it.
   * Holds the project's lock, so a machine acquired meanwhile keeps the network it was given.
   */
  const removeUnusedNetwork = Effect.fn("MachineService.removeUnusedNetwork")(function* (
    entry: ConnectedHost,
    projectId: ProjectId,
  ) {
    yield* projectLock.withLock(
      projectId,
      Effect.gen(function* () {
        const remaining = yield* leasesOf(projectId);
        if (remaining.some((lease) => lease.hostId === entry.host.id)) return;
        const network = yield* entry.lxd.network(projectNetworkName(projectId));
        if (Option.isSome(network) && network.value.usedBy.length === 0) {
          yield* entry.lxd.deleteNetwork(projectNetworkName(projectId));
        }
      }),
    );
  });

  const failLease = (lease: MachineLease, cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : "Unexpected failure";
    return updateLease(lease, (current) => ({ ...current, status: "failed", error: message })).pipe(
      Effect.andThen(Effect.logWarning("Machine failed", { leaseId: lease.leaseId, cause })),
      Effect.ignore,
    );
  };

  /** Runs `work` for the lease in the background, recording its failure on the lease. */
  const startTask = (
    lease: MachineLease,
    work: Effect.Effect<void, MachineError>,
    options?: { readonly onlyIfMissing?: boolean },
  ) =>
    FiberMap.run(
      tasks,
      lease.leaseId,
      work.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : failLease(lease, cause),
        ),
      ),
      options,
    );

  /** Host keys once cloud-init has finished this boot; none while it hasn't, or LXD can't tell yet. */
  const probeBooted = Effect.fn("MachineService.probeBooted")(function* (
    lxd: LxdClient,
    instance: string,
  ) {
    const probe = Effect.gen(function* () {
      const result = yield* lxd.readInstanceFile(instance, CLOUD_INIT_RESULT_PATH);
      if (Option.isNone(result)) return Option.none<ReadonlyArray<string>>();
      const keys = yield* Effect.forEach(HOST_KEY_PATHS, (keyPath) =>
        lxd.readInstanceFile(instance, keyPath),
      );
      return Option.some(
        keys.flatMap((key) =>
          Option.isSome(key)
            ? [new TextDecoder().decode(key.value).trim().split(/\s+/).slice(0, 2).join(" ")]
            : [],
        ),
      );
    });
    return yield* probe.pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
    );
  });

  const becomeReady = Effect.fn("MachineService.becomeReady")(function* (
    lease: MachineLease,
    lxd: LxdClient,
  ) {
    const deadline = (yield* now) + Duration.toMillis(BOOT_TIMEOUT);
    let hostKeys = yield* probeBooted(lxd, lease.instance);
    while (Option.isNone(hostKeys)) {
      if ((yield* now) > deadline) return yield* refused("boot-timeout", lease.name);
      yield* Effect.sleep(BOOT_POLL_INTERVAL);
      hostKeys = yield* probeBooted(lxd, lease.instance);
    }
    if (hostKeys.value.length === 0) return yield* refused("no-host-keys", lease.name);
    const keys = hostKeys.value;
    yield* updateLease(lease, (current) => ({
      ...current,
      status: "ready",
      error: null,
      hostKeys: keys,
    }));
    yield* syncProjectSsh(lease.projectId);
  });

  const provision = Effect.fn("MachineService.provision")(function* (
    initial: MachineLease,
    devicesOfProfiles: ReadonlyMap<
      string,
      { readonly profile: string; readonly device: Readonly<Record<string, string>> }
    >,
  ) {
    let lease = initial;
    const { lxd } = yield* connectedHostOf(lease);
    // This replaces any eth0 the machine's LXD profiles have.
    const devices: DeviceMap = {
      eth0: { type: "nic", name: "eth0", network: lease.network },
    };
    const sizes = lease.profile.diskSizesGiB;
    if (sizes.length > 0) {
      const pool = [...devicesOfProfiles.values()].find(
        ({ device }) => device.type === "disk" && device.path === "/",
      )?.device.pool;
      if (pool === undefined) return yield* refused("no-root-disk");
      const volumes = sizes.map((_, index) => `${lease.instance}-disk${index + 1}`);
      // Recorded before they exist, so releasing a half-made machine still finds its disks.
      const recorded = yield* updateLease(lease, (current) => ({
        ...current,
        storagePool: pool,
        volumes,
      }));
      if (Option.isNone(recorded)) return;
      lease = recorded.value;
      for (const [index, volume] of volumes.entries()) {
        yield* lxd.createBlockVolume(pool, volume, sizes[index]!);
        devices[`disk${index + 1}`] = { type: "disk", pool, source: volume };
      }
    }
    const key = yield* ensureSshKey;
    const environmentId = yield* platform.environmentId;
    yield* lxd.createInstance({
      name: lease.instance,
      description: `T3 Code machine ${lease.name} of project ${lease.projectId}`,
      type: lease.profile.type,
      source: machineImageSource(lease.profile.image),
      profiles: lease.profile.lxdProfiles,
      config: machineInstanceConfig({
        environmentId,
        projectId: lease.projectId,
        leaseId: lease.leaseId,
        name: lease.name,
        profile: lease.profile,
        publicKey: key.publicKey,
      }),
      devices,
      start: true,
    });
    const starting = yield* updateLease(lease, (current) => ({ ...current, status: "starting" }));
    if (Option.isNone(starting)) return;
    yield* becomeReady(starting.value, lxd);
  });

  /** Picks up a machine whose creation or boot a restart interrupted. */
  const resume = Effect.fn("MachineService.resume")(function* (lease: MachineLease) {
    const { lxd } = yield* connectedHostOf(lease);
    if (lease.status === "creating") {
      // LXD lists the instance only once it has its image, which for a first VM can take minutes.
      const deadline = (yield* now) + Duration.toMillis(BOOT_TIMEOUT);
      while (Option.isNone(yield* lxd.instance(lease.instance))) {
        if ((yield* now) > deadline) return yield* refused("interrupted");
        yield* Effect.sleep(BOOT_POLL_INTERVAL);
      }
      const starting = yield* updateLease(lease, (current) => ({ ...current, status: "starting" }));
      if (Option.isNone(starting)) return;
      return yield* becomeReady(starting.value, lxd);
    }
    yield* becomeReady(lease, lxd);
  });

  const awaitTask = Effect.fn("MachineService.awaitTask")(function* (
    leaseId: string,
    waitFor: Duration.Input,
  ) {
    const task = yield* FiberMap.get(tasks, leaseId);
    if (Option.isSome(task)) {
      yield* Fiber.await(task.value).pipe(Effect.timeoutOption(waitFor));
    }
  });

  /** Starts a ready machine that's stopped and watches it boot. */
  const wake = Effect.fn("MachineService.wake")(function* (lease: MachineLease) {
    if (lease.status !== "ready" || (yield* FiberMap.has(tasks, lease.leaseId))) return;
    const { lxd } = yield* connectedHostOf(lease);
    const instance = yield* lxd.instance(lease.instance);
    if (Option.isNone(instance) || instance.value.status !== "Stopped") return;
    yield* lxd.setInstanceState(lease.instance, "start");
    const starting = yield* updateLease(lease, (current) => ({ ...current, status: "starting" }));
    if (Option.isSome(starting)) yield* startTask(starting.value, becomeReady(starting.value, lxd));
  });

  const viewOf = (
    lease: MachineLease,
    state: MachineState,
    hostLabel: string,
    addresses: ReadonlyArray<string>,
  ): MachineView => ({
    name: lease.name,
    profile: lease.profile.name,
    type: lease.profile.type,
    image: lease.profile.image,
    cpus: lease.profile.cpus,
    memoryGiB: lease.profile.memoryGiB,
    diskSizesGiB: lease.profile.diskSizesGiB,
    state,
    hostLabel,
    dnsName: `${lease.instance}.${MACHINE_DNS_DOMAIN}`,
    addresses,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(lease.expiresAt)),
    sshCommand: `ssh -F ${sshConfigPath(lease.projectId)} ${lease.name}`,
    threadId: lease.threadId,
    ...(lease.error === null ? {} : { error: lease.error }),
  });

  const list = Effect.fn("MachineService.list")(function* (projectId: ProjectId) {
    const leases = yield* leasesOf(projectId);
    if (leases.length === 0) return [];
    const connected = yield* hosts.connected;
    const allHosts = yield* platform.hosts;
    const instancesByHost = new Map<string, ReadonlyMap<string, string> | undefined>();
    for (const lease of leases) {
      if (instancesByHost.has(lease.hostId)) continue;
      const entry = hostOf(connected, lease);
      const instances = entry
        ? yield* entry.lxd.instances.pipe(Effect.option)
        : Option.none<ReadonlyArray<{ readonly name: string; readonly status: string }>>();
      instancesByHost.set(
        lease.hostId,
        Option.isSome(instances)
          ? new Map(instances.value.map((instance) => [instance.name, instance.status]))
          : undefined,
      );
    }
    return yield* Effect.forEach(
      leases,
      Effect.fnUntraced(function* (lease) {
        const label =
          hostOf(connected, lease)?.host.label ??
          allHosts.find((host) => host.id === lease.hostId)?.label ??
          lease.hostId;
        const instances = instancesByHost.get(lease.hostId);
        if (lease.status !== "ready") return viewOf(lease, lease.status, label, []);
        if (instances === undefined) return viewOf(lease, "disconnected", label, []);
        const status = instances.get(lease.instance);
        if (status === undefined) return viewOf(lease, "missing", label, []);
        if (status !== "Running") return viewOf(lease, "stopped", label, []);
        const entry = hostOf(connected, lease)!;
        const addresses = yield* entry.lxd
          .instanceAddresses(lease.instance)
          .pipe(Effect.orElseSucceed(() => []));
        return viewOf(lease, "ready", label, addresses);
      }),
      { concurrency: "unbounded" },
    );
  });

  const profiles = (projectId: ProjectId) => platform.profiles(projectId);

  const viewByName = Effect.fn("MachineService.viewByName")(function* (
    projectId: ProjectId,
    name: string,
  ) {
    const view = (yield* list(projectId)).find((candidate) => candidate.name === name);
    if (!view) return yield* refused("not-found", name);
    return view;
  });

  const acquire = Effect.fn("MachineService.acquire")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly profile: string;
    readonly name?: string | undefined;
    readonly waitFor?: Duration.Input | undefined;
  }) {
    const { projectId } = input;
    const { lease, devices } = yield* projectLock.withLock(
      projectId,
      Effect.gen(function* () {
        const offered = yield* profiles(projectId);
        if (offered.length === 0) return yield* refused("no-profiles");
        const profile = offered.find((candidate) => candidate.name === input.profile);
        if (!profile) {
          return yield* refused(
            "unknown-profile",
            input.profile,
            offered.map((candidate) => candidate.name),
          );
        }
        const leases = yield* leasesOf(projectId);
        if (leases.length >= MAX_MACHINES_PER_PROJECT) return yield* refused("limit");
        let name = input.name?.trim() ?? "";
        for (let number = 1; name === ""; number++) {
          const candidate = `${profile.name}-${number}`;
          if (!leases.some((lease) => lease.name === candidate)) name = candidate;
        }
        if (leases.some((lease) => lease.name === name)) return yield* refused("name-taken", name);
        const connected = yield* hosts.connected;
        if (connected.length === 0) return yield* refused("no-hosts");
        const placed = yield* placement(connected, leases, profile);
        yield* ensureSshKey;
        yield* aclLock.withLock(placed.entry.host.id, applyNetworkAcl(placed.entry));
        yield* ensureProjectNetwork(placed.entry, projectId, placed.uplink);
        const createdAt = yield* now;
        const lease: MachineLease = {
          leaseId: NodeCrypto.randomUUID(),
          projectId,
          threadId: input.threadId,
          name,
          hostId: placed.entry.host.id,
          instance: machineInstanceName(projectId, name),
          network: projectNetworkName(projectId),
          profile,
          storagePool: null,
          volumes: [],
          status: "creating",
          error: null,
          hostKeys: [],
          createdAt,
          expiresAt: createdAt + profile.lifetimeHours * 3_600_000,
          lastUsedAt: createdAt,
        };
        yield* store.save(lease);
        yield* notify(projectId);
        return { lease, devices: placed.devices };
      }),
    );
    yield* startTask(lease, provision(lease, devices));
    yield* awaitTask(lease.leaseId, input.waitFor ?? 0);
    return yield* viewByName(projectId, lease.name);
  });

  const wait = Effect.fn("MachineService.wait")(function* (input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly waitFor?: Duration.Input | undefined;
  }) {
    const lease = yield* findLease(input.projectId, input.name);
    yield* store.touch(lease.leaseId, yield* now);
    yield* wake(lease);
    yield* awaitTask(lease.leaseId, input.waitFor ?? 0);
    return yield* viewByName(input.projectId, input.name);
  });

  /** Deletes the instance and its disks. Both already being gone is fine. */
  const destroy = Effect.fn("MachineService.destroy")(function* (
    entry: ConnectedHost,
    lease: MachineLease,
  ) {
    const instance = yield* entry.lxd.instance(lease.instance);
    if (Option.isSome(instance)) {
      if (instance.value.status !== "Stopped") {
        yield* entry.lxd.setInstanceState(lease.instance, "stop", true);
      }
      yield* entry.lxd.deleteInstance(lease.instance);
    }
    if (lease.storagePool !== null) {
      for (const volume of lease.volumes) yield* entry.lxd.deleteVolume(lease.storagePool, volume);
    }
  });

  /**
   * Marks the lease releasing first: a lease on a host that isn't connected
   * now is finished by a later sweep, once it's connected again.
   */
  const releaseLease = Effect.fn("MachineService.releaseLease")(function* (lease: MachineLease) {
    yield* FiberMap.remove(tasks, lease.leaseId);
    const releasing = yield* updateLease(lease, (current) => ({ ...current, status: "releasing" }));
    if (Option.isNone(releasing)) return;
    yield* syncProjectSsh(lease.projectId);
    const entry = hostOf(yield* hosts.connected, lease);
    if (!entry) return;
    yield* destroy(entry, lease);
    yield* projectLock.withLock(lease.projectId, store.remove(lease.leaseId));
    yield* notify(lease.projectId);
    yield* removeUnusedNetwork(entry, lease.projectId);
    yield* syncProjectSsh(lease.projectId);
  });

  const release = Effect.fn("MachineService.release")(function* (input: {
    readonly projectId: ProjectId;
    readonly name: string;
  }) {
    yield* releaseLease(yield* findLease(input.projectId, input.name));
  });

  /** Stops a running machine nobody has used for a while; the next ssh starts it again. */
  const stopIdle = Effect.fn("MachineService.stopIdle")(function* (
    entry: ConnectedHost,
    lease: MachineLease,
    at: number,
  ) {
    if (lease.status !== "ready" || (openConnections.get(lease.leaseId) ?? 0) > 0) return;
    if (at - lease.lastUsedAt < Duration.toMillis(IDLE_STOP_AFTER)) return;
    const instance = yield* entry.lxd.instance(lease.instance);
    if (Option.isSome(instance) && instance.value.status === "Running") {
      yield* entry.lxd.setInstanceState(lease.instance, "stop");
      yield* notify(lease.projectId);
    }
  });

  const sweepProject = Effect.fn("MachineService.sweepProject")(function* (
    projectId: ProjectId,
    at: number,
  ) {
    const deleted = !(yield* platform.projectExists(projectId));
    const connected = yield* hosts.connected;
    for (const lease of yield* leasesOf(projectId)) {
      const entry = hostOf(connected, lease);
      if (!entry) continue;
      const busy = yield* FiberMap.has(tasks, lease.leaseId);
      if (deleted || lease.status === "releasing" || (lease.expiresAt <= at && !busy)) {
        yield* releaseLease(lease);
      } else if ((lease.status === "creating" || lease.status === "starting") && !busy) {
        yield* startTask(lease, resume(lease), { onlyIfMissing: true });
      } else {
        yield* stopIdle(entry, lease, at);
      }
    }
  });

  const sweep = Effect.gen(function* () {
    const at = yield* now;
    const projectIds = [...new Set((yield* store.list).map((lease) => lease.projectId))];
    for (const projectId of projectIds) {
      yield* sweepProject(projectId, at).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machine sweep failed for a project", { projectId, cause }),
        ),
      );
    }
  }).pipe(
    sweepLock.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("Machine sweep failed", { cause })),
    Effect.withSpan("MachineService.sweep"),
  );

  /** For a new SSH connection: starts the machine if it's stopped and waits while it boots. */
  const usable = Effect.fn("MachineService.usable")(function* (projectId: ProjectId, name: string) {
    const lease = yield* findLease(projectId, name);
    yield* wake(lease);
    yield* awaitTask(lease.leaseId, BOOT_TIMEOUT);
    const current = yield* findLease(projectId, name);
    if (current.status !== "ready") return yield* refused("not-ready", name);
    yield* store.touch(current.leaseId, yield* now);
    return { lease: current, lxd: (yield* connectedHostOf(current)).lxd };
  });

  const relayConnection =
    (projectId: ProjectId, name: string) =>
    (socket: NodeNet.Socket): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { lease, lxd } = yield* usable(projectId, name);
        const key = lease.leaseId;
        openConnections.set(key, (openConnections.get(key) ?? 0) + 1);
        yield* Effect.gen(function* () {
          const exec = yield* lxd.exec(lease.instance, MACHINE_SSH_RELAY_COMMAND);
          const result = yield* relaySshConnection(socket, exec);
          if (result.exitCode !== 0) {
            yield* Effect.logWarning("SSH relay to a machine ended badly", {
              instance: lease.instance,
              exitCode: result.exitCode,
              stderr: result.stderr,
            });
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => openConnections.set(key, (openConnections.get(key) ?? 1) - 1)),
          ),
          Effect.ensuring(
            now.pipe(
              Effect.flatMap((at) => store.touch(key, at)),
              Effect.ignore,
            ),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("SSH relay to a machine failed", { projectId, name, cause }),
        ),
      );

  const subscribeProject = (projectId: ProjectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed before the first list, so a change while it runs isn't missed.
        const subscription = yield* PubSub.subscribe(changed);
        return Stream.concat(
          Stream.succeed(projectId),
          Stream.fromSubscription(subscription).pipe(Stream.filter((id) => id === projectId)),
        ).pipe(Stream.mapEffect(() => list(projectId)));
      }),
    );

  const inspectHost = Effect.fn("MachineService.inspectHost")(function* (
    host: MachineHostConfig,
    connected: ReadonlyArray<ConnectedHost>,
    environmentId: string,
    leaseIds: ReadonlySet<string>,
  ) {
    const entry = connected.find((candidate) => candidate.host.id === host.id);
    if (!entry) {
      return {
        inspection: {
          hostId: host.id,
          error: "T3 Code's key for this server is missing. Disconnect it and connect it again.",
        },
        untracked: [],
      };
    }
    const result = yield* Effect.all([hosts.status(host.id), entry.lxd.instances]).pipe(
      Effect.timeoutOption(INSPECT_TIMEOUT),
      Effect.result,
    );
    if (Result.isFailure(result) || Option.isNone(result.success)) {
      return {
        inspection: {
          hostId: host.id,
          error: Result.isFailure(result)
            ? result.failure.message
            : `It didn't answer within ${Duration.format(INSPECT_TIMEOUT)}.`,
        },
        untracked: [],
      };
    }
    const [status, instances] = result.success.value;
    const untracked = instances.flatMap((instance): ReadonlyArray<UntrackedMachine> => {
      const tags = machineInstanceTags(environmentId, instance.config);
      if (!tags || (tags.leaseId !== undefined && leaseIds.has(tags.leaseId))) return [];
      return [
        {
          hostId: host.id,
          instance: instance.name,
          type: instance.type,
          status: instance.status,
          ...(tags.projectId === undefined ? {} : { projectId: tags.projectId }),
        },
      ];
    });
    return {
      inspection: {
        hostId: host.id,
        status: {
          serverName: status.serverName,
          version: status.version,
          versionSupported: status.versionSupported,
          instanceTypes: status.instanceTypes,
          ...(status.sandbox.uplink === undefined ? {} : { uplink: status.sandbox.uplink }),
          missing: status.sandbox.missing,
          unsafe: status.sandbox.unsafe,
        },
      },
      untracked,
    };
  });

  const inspectHosts = Effect.gen(function* () {
    const configured = yield* platform.hosts;
    if (configured.length === 0) return { hosts: [], untracked: [] };
    const connected = yield* hosts.connected;
    const environmentId = yield* platform.environmentId;
    const leaseIds = new Set((yield* store.list).map((lease) => lease.leaseId));
    const results = yield* Effect.forEach(
      configured,
      (host) => inspectHost(host, connected, environmentId, leaseIds),
      { concurrency: "unbounded" },
    );
    return {
      hosts: results.map((result) => result.inspection),
      untracked: results.flatMap((result) => result.untracked),
    };
  }).pipe(Effect.withSpan("MachineService.inspectHosts"));

  const deleteUntracked = Effect.fn("MachineService.deleteUntracked")(function* (
    input: UntrackedMachineInput,
  ) {
    const entry = (yield* hosts.connected).find((candidate) => candidate.host.id === input.hostId);
    if (!entry) return yield* refused("host-disconnected", input.instance);
    const environmentId = yield* platform.environmentId;
    const instance = yield* entry.lxd.instance(input.instance);
    const tags = Option.isSome(instance)
      ? machineInstanceTags(environmentId, instance.value.config)
      : undefined;
    const leases = yield* store.list;
    // Only this environment's machines, and never one a project still has.
    if (
      Option.isNone(instance) ||
      !tags ||
      leases.some((lease) => lease.leaseId === tags.leaseId)
    ) {
      return yield* refused("untracked-not-found", input.instance);
    }
    if (instance.value.status !== "Stopped") {
      yield* entry.lxd.setInstanceState(input.instance, "stop", true);
    }
    yield* entry.lxd.deleteInstance(input.instance);
    // Extra disks are custom volumes; the root disk comes from a profile and goes with the instance.
    for (const device of Object.values(instance.value.devices)) {
      if (device.type === "disk" && device.pool !== undefined && device.source !== undefined) {
        yield* entry.lxd.deleteVolume(device.pool, device.source);
      }
    }
    if (tags.projectId !== undefined) {
      yield* removeUnusedNetwork(entry, ProjectId.make(tags.projectId));
    }
  });

  // A server connecting, going away or being renamed changes how its machines show.
  const followHosts = platform.hostChanges.pipe(
    Stream.map((current) =>
      current.map((host) => [host.id, host.label, host.clientKey !== ""].join("\0")).join("\n"),
    ),
    Stream.changes,
    Stream.runForEach(() =>
      store.list.pipe(
        Effect.flatMap((leases) =>
          Effect.forEach(new Set(leases.map((lease) => lease.projectId)), notify),
        ),
        Effect.ignore,
      ),
    ),
  );

  const startup = Effect.gen(function* () {
    const projectIds = [...new Set((yield* store.list).map((lease) => lease.projectId))];
    for (const projectId of projectIds) {
      yield* syncProjectSsh(projectId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Machines couldn't restore a project's SSH files", {
            projectId,
            cause,
          }),
        ),
      );
    }
    yield* sweep;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Machine startup failed", { cause })));

  const run = Effect.all(
    [
      followHosts,
      startup.pipe(
        Effect.andThen(Effect.sleep(SWEEP_INTERVAL)),
        Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );

  return MachineService.of({
    acquire,
    list,
    profiles,
    wait,
    release,
    subscribeProject,
    inspectHosts,
    deleteUntracked,
    sshConfigPath,
    sweep,
    run,
  });
});

export const layer = Layer.effect(MachineService, make);
