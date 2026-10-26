import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineHostConfig,
  MachineProfile,
  type MachineView,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import { type LxdClient, type LxdInstance, LxdRequestError } from "./lxd/LxdClient.ts";
import * as MachineHosts from "./MachineHosts.ts";
import * as MachineLeaseStore from "./MachineLeaseStore.ts";
import { threadNetworkName } from "./MachineSandbox.ts";
import * as MachineService from "./MachineService.ts";
import * as MachineThreads from "./MachineThreads.ts";

const THREAD = ThreadId.make("thread-1");
const PROJECT = ProjectId.make("project-1");

const decodeProfile = Schema.decodeSync(MachineProfile);
const profile = (fields: Partial<MachineProfile> & Pick<MachineProfile, "name" | "type">) =>
  decodeProfile({ image: "ubuntu:24.04", ...fields });

const SANDBOXED_PROJECT = {
  restricted: "true",
  "restricted.snapshots": "allow",
  "features.images": "true",
  "features.profiles": "true",
  "features.networks": "true",
  "restricted.networks.uplinks": "uplink0",
};

const ROOT_DISK = { root: { type: "disk", path: "/", pool: "local" } };

interface FakeInstance {
  readonly name: string;
  readonly type: string;
  status: "Running" | "Stopped";
  readonly config: Readonly<Record<string, string>>;
  readonly devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Readiness probes answered since the last start. */
  probes: number;
}

type ProfileDevices = Readonly<Record<string, Record<string, string>>>;

/** An LXD server in memory: instances boot after `bootAfterProbes` readiness probes. */
function makeFakeLxd(
  options: {
    readonly version?: string;
    readonly instanceTypes?: ReadonlyArray<string>;
    readonly projectConfig?: Readonly<Record<string, string>>;
    readonly profiles?: Readonly<Record<string, ProfileDevices>>;
    readonly bootAfterProbes?: number;
    readonly failCreate?: boolean;
  } = {},
) {
  const instances = new Map<string, FakeInstance>();
  const networks = new Map<string, Readonly<Record<string, string>>>();
  const acls = new Map<string, unknown>();
  const volumes = new Map<string, number>();
  const calls: Array<string> = [];
  const profiles: Readonly<Record<string, ProfileDevices>> = options.profiles ?? {
    default: ROOT_DISK,
  };
  const bootAfter = options.bootAfterProbes ?? 1;

  const asInstance = (instance: FakeInstance): LxdInstance => ({
    name: instance.name,
    type: instance.type,
    status: instance.status,
    config: instance.config,
    devices: instance.devices,
  });
  const record = (call: string) => Effect.sync(() => void calls.push(call));

  const lxd: LxdClient = {
    address: "10.0.0.1:8443",
    fingerprint: "f".repeat(64),
    server: Effect.succeed({
      name: "fake",
      version: options.version ?? "6.10.0",
      instanceTypes: options.instanceTypes ?? ["container", "virtual-machine"],
    }),
    addCertificate: () => Effect.void,
    ownCertificate: Effect.succeed({ restricted: true, projects: ["t3"] }),
    removeOwnCertificate: Effect.void,
    projectConfig: () => Effect.succeed({ ...(options.projectConfig ?? SANDBOXED_PROJECT) }),
    instances: Effect.sync(() => [...instances.values()].map(asInstance)),
    instance: (name) =>
      Effect.sync(() => Option.map(Option.fromNullishOr(instances.get(name)), asInstance)),
    instanceAddresses: () => Effect.succeed(["10.1.1.2"]),
    profileDevices: (name) => Effect.succeed(Option.fromNullishOr(profiles[name])),
    network: (name) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(networks.get(name)), (config) => ({
          config,
          usedBy: [...instances.values()]
            .filter((instance) => instance.devices.eth0?.network === name)
            .map((instance) => `/1.0/instances/${instance.name}`),
        })),
      ),
    createNetwork: (post) =>
      Effect.sync(() => void networks.set(post.name, post.config)).pipe(
        Effect.andThen(record(`createNetwork ${post.name}`)),
      ),
    updateNetwork: (name, config) =>
      Effect.sync(() => void networks.set(name, { ...networks.get(name), ...config })),
    deleteNetwork: (name) =>
      Effect.sync(() => void networks.delete(name)).pipe(
        Effect.andThen(record(`deleteNetwork ${name}`)),
      ),
    networkAcl: (name) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(acls.get(name)), () => ({ egress: [], ingress: [] })),
      ),
    createNetworkAcl: (name, put) =>
      Effect.sync(() => void acls.set(name, put)).pipe(Effect.andThen(record(`createAcl ${name}`))),
    updateNetworkAcl: (name, put) => Effect.sync(() => void acls.set(name, put)),
    createInstance: (post) =>
      options.failCreate
        ? Effect.fail(
            new LxdRequestError({
              operation: "POST /1.0/instances",
              status: 500,
              reason: "Insufficient resources",
            }),
          )
        : Effect.sync(() => {
            instances.set(post.name, {
              name: post.name,
              type: post.type,
              status: post.start ? "Running" : "Stopped",
              config: post.config ?? {},
              devices: post.devices ?? {},
              probes: 0,
            });
          }).pipe(Effect.andThen(record(`createInstance ${post.name}`))),
    setInstanceState: (name, action) =>
      Effect.sync(() => {
        const instance = instances.get(name);
        if (!instance) return;
        instance.status = action === "start" ? "Running" : "Stopped";
        instance.probes = 0;
      }).pipe(Effect.andThen(record(`${action} ${name}`))),
    deleteInstance: (name) =>
      Effect.sync(() => void instances.delete(name)).pipe(
        Effect.andThen(record(`deleteInstance ${name}`)),
      ),
    readInstanceFile: (name, path) =>
      Effect.sync(() => {
        const instance = instances.get(name);
        if (!instance || instance.status !== "Running") return Option.none();
        if (path === "/run/cloud-init/result.json") {
          instance.probes += 1;
          return instance.probes >= bootAfter
            ? Option.some(new TextEncoder().encode("{}"))
            : Option.none();
        }
        return path.endsWith("ssh_host_ed25519_key.pub")
          ? Option.some(new TextEncoder().encode(`ssh-ed25519 AAAA${name} root@${name}\n`))
          : Option.none();
      }),
    createBlockVolume: (pool, volume, sizeGiB) =>
      Effect.sync(() => void volumes.set(`${pool}/${volume}`, sizeGiB)),
    deleteVolume: (pool, volume) => Effect.sync(() => void volumes.delete(`${pool}/${volume}`)),
    exec: () => Effect.die("exec isn't faked"),
  };
  return { lxd, instances, networks, acls, volumes, calls };
}

type FakeLxd = ReturnType<typeof makeFakeLxd>;

const hostConfig = (id: string): MachineHostConfig => ({
  id,
  label: `LXD ${id}`,
  address: "10.0.0.1:8443",
  serverCertificate: "server",
  project: "t3",
  clientCertificate: "client",
  clientKey: "key",
});

/** ssh-keygen without the binary: writes a key pair where it was asked to. */
const fakeProcessRunner = Layer.effect(
  ProcessRunner.ProcessRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const keyPath = input.args[input.args.indexOf("-f") + 1]!;
          yield* fs.writeFileString(keyPath, "PRIVATE");
          yield* fs.writeFileString(`${keyPath}.pub`, "ssh-ed25519 AAAAtest t3-code-machines\n");
          return {
            stdout: "",
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }).pipe(Effect.orDie),
    });
  }),
);

interface Harness {
  readonly hosts: Map<string, FakeLxd>;
  readonly thread: { state: MachineThreads.MachineThreadState | undefined };
}

function makeLayer(input: {
  readonly hosts: ReadonlyArray<readonly [string, FakeLxd]>;
  readonly profiles: ReadonlyArray<MachineProfile>;
  readonly seed?: ReadonlyArray<MachineLeaseStore.MachineLease>;
}) {
  const harness: Harness = {
    hosts: new Map(input.hosts),
    thread: {
      state: { projectId: PROJECT, archived: false, settled: false, running: false, lastTurnAt: 0 },
    },
  };
  const hostsLayer = Layer.succeed(
    MachineHosts.MachineHosts,
    MachineHosts.MachineHosts.of({
      connect: () => Effect.die("unused"),
      disconnect: () => Effect.die("unused"),
      status: () =>
        Effect.succeed({
          serverName: "fake",
          version: "6.10.0",
          versionSupported: true,
          instanceTypes: ["container", "virtual-machine"],
          sandbox: { uplink: "uplink0", missing: [], unsafe: [] },
        }),
      connected: Effect.sync(() =>
        [...harness.hosts].map(([id, fake]) => ({ host: hostConfig(id), lxd: fake.lxd })),
      ),
    }),
  );
  const threadsLayer = Layer.succeed(
    MachineThreads.MachineThreads,
    MachineThreads.MachineThreads.of({
      get: () => Effect.sync(() => Option.fromNullishOr(harness.thread.state)),
      lifecycleChanges: Stream.never,
    }),
  );
  const environmentLayer = Layer.succeed(
    ServerEnvironment.ServerEnvironment,
    ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
      getDescriptor: Effect.die("unused"),
    }),
  );
  const storeLayer = MachineLeaseStore.layer.pipe(
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const seedLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* MachineLeaseStore.MachineLeaseStore;
      for (const lease of input.seed ?? []) yield* store.save(lease);
    }),
  );
  const layer = MachineService.layer.pipe(
    Layer.provide(seedLayer),
    Layer.provideMerge(storeLayer),
    Layer.provide(
      Layer.mergeAll(
        hostsLayer,
        threadsLayer,
        environmentLayer,
        Settings.ServerSettingsService.layerTest({
          machineProfiles: [...input.profiles],
          machineHosts: input.hosts.map(([id]) => hostConfig(id)),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-test-" }),
        fakeProcessRunner,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
}

const VM = profile({ name: "vm", type: "virtual-machine", diskSizesGiB: [4, 8] });
const CONTAINER = profile({ name: "box", type: "container" });

describe("MachineService", () => {
  it.effect("creates a VM with extra disks on the thread's own network", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [VM] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const fs = yield* FileSystem.FileSystem;
      const acquired = yield* machines.acquire({ threadId: THREAD, profile: "vm" });
      assert.strictEqual(acquired.name, "vm-1");

      const view = yield* machines.wait({ threadId: THREAD, name: "vm-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "ready");
      assert.deepStrictEqual(view.diskSizesGiB, [4, 8]);
      assert.include(view.sshCommand, machines.sshConfigPath(THREAD));

      const [instance] = [...fake.instances.values()];
      assert.isDefined(instance);
      const network = instance!.devices.eth0!.network!;
      assert.match(network, /^t3m-[0-9a-f]{8}$/);
      assert.strictEqual(fake.networks.get(network)?.["security.acls"], "t3-machines");
      assert.deepStrictEqual(instance!.devices.disk1, {
        type: "disk",
        pool: "local",
        source: `${instance!.name}-disk1`,
      });
      assert.deepStrictEqual(
        [...fake.volumes],
        [
          [`local/${instance!.name}-disk1`, 4],
          [`local/${instance!.name}-disk2`, 8],
        ],
      );
      assert.strictEqual(instance!.config["user.t3.environment"], "environment-1");
      assert.strictEqual(instance!.config["user.t3.thread"], THREAD);
      assert.strictEqual(instance!.config["limits.memory"], "2GiB");
      assert.include(instance!.config["cloud-init.vendor-data"]!, "ssh-ed25519 AAAAtest");

      const config = yield* fs.readFileString(machines.sshConfigPath(THREAD));
      assert.include(config, "Host vm-1\n");
      assert.include(config, "StrictHostKeyChecking yes");
      const knownHosts = yield* fs.readFileString(
        machines.sshConfigPath(THREAD).replace(/ssh_config$/, "known_hosts"),
      );
      assert.strictEqual(knownHosts, `vm-1 ssh-ed25519 AAAA${instance!.name}\n`);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "records extra disks before creating the instance, so a failed one is cleaned up",
    () => {
      const fake = makeFakeLxd({ failCreate: true });
      const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [VM] });
      return Effect.gen(function* () {
        const machines = yield* MachineService.MachineService;
        yield* machines.acquire({ threadId: THREAD, profile: "vm" });
        const failed = yield* machines.wait({
          threadId: THREAD,
          name: "vm-1",
          waitFor: "1 minute",
        });
        assert.strictEqual(failed.state, "failed");
        assert.include(failed.error!, "Insufficient resources");
        assert.strictEqual(fake.volumes.size, 2);

        yield* machines.release({ threadId: THREAD, name: "vm-1" });
        assert.strictEqual(fake.volumes.size, 0);
        assert.strictEqual(fake.networks.size, 0);
        assert.deepStrictEqual(yield* machines.list(THREAD), []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("refuses what a thread or host can't have", () => {
    const fake = makeFakeLxd({
      profiles: {
        default: ROOT_DISK,
        bridged: { eth1: { type: "nic", network: "lxdbr0" } },
      },
    });
    const { layer } = makeLayer({
      hosts: [["host-a", fake]],
      profiles: [
        CONTAINER,
        profile({ name: "leaky", type: "container", lxdProfiles: ["default", "bridged"] }),
      ],
    });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const refusal = <A>(effect: Effect.Effect<A, MachineService.MachineError>) =>
        effect.pipe(
          Effect.flip,
          Effect.orDie,
          Effect.map((error) => (error._tag === "MachineRefusedError" ? error.reason : error._tag)),
        );
      assert.strictEqual(
        yield* refusal(machines.acquire({ threadId: THREAD, profile: "nope" })),
        "unknown-profile",
      );
      assert.strictEqual(
        yield* refusal(machines.acquire({ threadId: THREAD, profile: "leaky" })),
        "extra-nic",
      );
      for (let index = 0; index < 5; index++) {
        yield* machines.acquire({ threadId: THREAD, profile: "box" });
      }
      assert.strictEqual(
        yield* refusal(machines.acquire({ threadId: THREAD, profile: "box" })),
        "limit",
      );
      assert.strictEqual(
        yield* refusal(
          machines
            .acquire({ threadId: ThreadId.make("t2"), profile: "box", name: "box-1" })
            .pipe(
              Effect.andThen(
                machines.acquire({ threadId: ThreadId.make("t2"), profile: "box", name: "box-1" }),
              ),
            ),
        ),
        "name-taken",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an LXD project that doesn't keep machines sandboxed", () => {
    const fake = makeFakeLxd({ projectConfig: { ...SANDBOXED_PROJECT, restricted: "false" } });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const error = yield* machines.acquire({ threadId: THREAD, profile: "box" }).pipe(Effect.flip);
      assert.strictEqual(error._tag === "MachineRefusedError" && error.reason, "unsandboxed");
      assert.strictEqual(fake.instances.size, 0);
      assert.strictEqual(fake.networks.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a machine that doesn't finish booting", () => {
    const fake = makeFakeLxd({ bootAfterProbes: Number.POSITIVE_INFINITY });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "box" });
      yield* TestClock.adjust("11 minutes");
      const view = yield* machines.wait({ threadId: THREAD, name: "box-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "failed");
      assert.include(view.error!, "didn't finish booting");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a thread's machines on one host and places new threads on the emptiest", () => {
    const busy = makeFakeLxd();
    const empty = makeFakeLxd();
    const { layer } = makeLayer({
      hosts: [
        ["busy", busy],
        ["empty", empty],
      ],
      profiles: [CONTAINER],
    });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      busy.instances.set("other", {
        name: "other",
        type: "container",
        status: "Running",
        config: {},
        devices: {},
        probes: 0,
      });
      const first = yield* machines.acquire({ threadId: THREAD, profile: "box" });
      assert.strictEqual(first.hostLabel, "LXD empty");
      // Now `empty` has more instances, but the thread's network is there.
      empty.instances.set("x", { ...busy.instances.get("other")!, name: "x" });
      const second = yield* machines.acquire({ threadId: THREAD, profile: "box" });
      assert.strictEqual(second.hostLabel, "LXD empty");
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases machines whose lifetime is over", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({
      hosts: [["host-a", fake]],
      profiles: [profile({ name: "box", type: "container", lifetimeHours: 2 })],
    });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "box", waitFor: "1 minute" });
      yield* TestClock.adjust("1 hour");
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 1);
      yield* TestClock.adjust("1 hour");
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.strictEqual(fake.networks.size, 0);
      assert.deepStrictEqual(yield* machines.list(THREAD), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops machines of a settled or idle thread and starts them again on demand", () => {
    const fake = makeFakeLxd();
    const { harness, layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "box", waitFor: "1 minute" });
      const [instance] = [...fake.instances.values()];

      harness.thread.state = { ...harness.thread.state!, settled: true };
      yield* machines.reconcileThread(THREAD);
      assert.strictEqual(instance!.status, "Stopped");
      assert.strictEqual((yield* machines.list(THREAD))[0]!.state, "stopped");

      const woken = yield* machines.wait({ threadId: THREAD, name: "box-1", waitFor: "1 minute" });
      assert.strictEqual(woken.state, "ready");

      harness.thread.state = { ...harness.thread.state!, settled: false, running: true };
      yield* TestClock.adjust("5 hours");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Running", "a running turn keeps machines up");

      harness.thread.state = {
        ...harness.thread.state!,
        running: false,
        lastTurnAt: Date.parse("1970-01-01T05:00:00Z"),
      };
      yield* TestClock.adjust("3 hours");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Running", "3 hours idle is not long enough");
      yield* TestClock.adjust("2 hours");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Stopped");
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases an archived thread's machines", () => {
    const fake = makeFakeLxd();
    const { harness, layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [VM] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "vm", waitFor: "1 minute" });
      harness.thread.state = { ...harness.thread.state!, archived: true };
      yield* machines.reconcileThread(THREAD);
      assert.strictEqual(fake.instances.size, 0);
      assert.strictEqual(fake.volumes.size, 0);
      assert.strictEqual(fake.networks.size, 0);
      // The ACL is shared by every thread's network in the project.
      assert.strictEqual(fake.acls.size, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finishes releasing once a disconnected host is back", () => {
    const fake = makeFakeLxd();
    const { harness, layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "box", waitFor: "1 minute" });
      harness.hosts.delete("host-a");
      yield* machines.release({ threadId: THREAD, name: "box-1" });
      assert.strictEqual(fake.instances.size, 1);
      assert.strictEqual((yield* machines.list(THREAD))[0]!.state, "releasing");

      harness.hosts.set("host-a", fake);
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.deepStrictEqual(yield* machines.list(THREAD), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resumes a machine whose creation a restart interrupted", () => {
    const fake = makeFakeLxd();
    const instance = "box-1-0000";
    fake.instances.set(instance, {
      name: instance,
      type: "container",
      status: "Running",
      config: {},
      devices: {},
      probes: 0,
    });
    const { layer } = makeLayer({
      hosts: [["host-a", fake]],
      profiles: [CONTAINER],
      seed: [
        {
          leaseId: "lease-1",
          threadId: THREAD,
          projectId: PROJECT,
          name: "box-1",
          hostId: "host-a",
          instance,
          network: "t3m-00000000",
          profile: CONTAINER,
          storagePool: null,
          volumes: [],
          status: "creating",
          error: null,
          hostKeys: [],
          createdAt: 0,
          expiresAt: 24 * 3_600_000,
          lastUsedAt: 0,
        },
      ],
    });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.sweep;
      const view = yield* machines.wait({ threadId: THREAD, name: "box-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "ready");
    }).pipe(Effect.provide(layer));
  });
  it.effect("pushes a thread's machines to its subscribers as they change", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const updates = yield* Queue.unbounded<ReadonlyArray<MachineView>>();
      yield* machines.subscribeThread(THREAD).pipe(
        Stream.runForEach((update) => Queue.offer(updates, update)),
        Effect.forkScoped,
      );
      const next = (done: (update: ReadonlyArray<MachineView>) => boolean) =>
        Effect.gen(function* () {
          let update = yield* Queue.take(updates);
          while (!done(update)) update = yield* Queue.take(updates);
          return update;
        });
      assert.deepStrictEqual(yield* Queue.take(updates), []);

      yield* machines.acquire({ threadId: THREAD, profile: "box", waitFor: "1 minute" });
      yield* next((update) => update[0]?.state === "ready");

      yield* machines.release({ threadId: THREAD, name: "box-1" });
      yield* next((update) => update.length === 0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("lists and deletes machines the environment lost track of", () => {
    const fake = makeFakeLxd();
    const lostThread = "thread-lost";
    const orphan = "lost-1-0000";
    fake.networks.set(threadNetworkName(lostThread), {});
    fake.volumes.set(`local/${orphan}-disk1`, 4);
    fake.instances.set(orphan, {
      name: orphan,
      type: "virtual-machine",
      status: "Running",
      config: {
        "user.t3.environment": "environment-1",
        "user.t3.thread": lostThread,
        "user.t3.lease": "lease-lost",
      },
      devices: {
        eth0: { type: "nic", network: threadNetworkName(lostThread) },
        disk1: { type: "disk", pool: "local", source: `${orphan}-disk1` },
      },
      probes: 0,
    });
    fake.instances.set("theirs", {
      name: "theirs",
      type: "container",
      status: "Running",
      config: { "user.t3.environment": "environment-2", "user.t3.lease": "lease-2" },
      devices: {},
      probes: 0,
    });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ threadId: THREAD, profile: "box", waitFor: "1 minute" });
      const leased = [...fake.instances.keys()].find((name) => name.startsWith("box-1-"))!;

      const inspection = yield* machines.inspectHosts;
      assert.strictEqual(inspection.hosts[0]?.status?.uplink, "uplink0");
      assert.deepStrictEqual(inspection.untracked, [
        {
          hostId: "host-a",
          instance: orphan,
          type: "virtual-machine",
          status: "Running",
          threadId: lostThread,
        },
      ]);

      // Neither a thread's machine nor another environment's is deleted this way.
      for (const instance of [leased, "theirs"]) {
        const refusal = yield* machines
          .deleteUntracked({ hostId: "host-a", instance })
          .pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "MachineRefusedError");
      }

      yield* machines.deleteUntracked({ hostId: "host-a", instance: orphan });
      assert.deepStrictEqual([...fake.instances.keys()].toSorted(), [leased, "theirs"]);
      assert.isFalse(fake.volumes.has(`local/${orphan}-disk1`));
      assert.isFalse(fake.networks.has(threadNetworkName(lostThread)));
      assert.deepStrictEqual((yield* machines.inspectHosts).untracked, []);
    }).pipe(Effect.provide(layer));
  });
});
