import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type MachineHostConfig,
  MachineProfile,
  type MachineView,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { type LxdClient, type LxdInstance, LxdRequestError } from "./lxd/LxdClient.ts";
import * as MachineHosts from "./MachineHosts.ts";
import * as MachineLeaseStore from "./MachineLeaseStore.ts";
import { MachinePlatform } from "./MachinePlatform.ts";
import { projectNetworkName } from "./MachineSandbox.ts";
import * as MachineService from "./MachineService.ts";

const THREAD = ThreadId.make("thread-1");
const OTHER_THREAD = ThreadId.make("thread-2");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
/** Who acquires, in PROJECT unless a test says otherwise. */
const BY = { projectId: PROJECT, threadId: THREAD };

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
    /** Replaces creating the instance, e.g. to hold LXD's operation open. */
    readonly onCreate?: (post: Parameters<LxdClient["createInstance"]>[0]) => Effect.Effect<void>;
    /** Runs before a start takes effect. */
    readonly onStart?: Effect.Effect<void>;
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
      options.onCreate
        ? options.onCreate(post)
        : options.failCreate
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
      (action === "start" && options.onStart ? options.onStart : Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const instance = instances.get(name);
            if (!instance) return;
            instance.status = action === "start" ? "Running" : "Stopped";
            instance.probes = 0;
          }),
        ),
        Effect.andThen(record(`${action} ${name}`)),
      ),
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

interface Harness {
  readonly hosts: Map<string, FakeLxd>;
  readonly deletedProjects: Set<ProjectId>;
}

function makeLayer(input: {
  readonly hosts: ReadonlyArray<readonly [string, FakeLxd]>;
  readonly profiles: ReadonlyArray<MachineProfile>;
  readonly seed?: ReadonlyArray<MachineLeaseStore.MachineLease>;
}) {
  const harness: Harness = { hosts: new Map(input.hosts), deletedProjects: new Set() };
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
  const platformLayer = Layer.effect(
    MachinePlatform,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configured = input.hosts.map(([id]) => hostConfig(id));
      return MachinePlatform.of({
        environmentId: Effect.succeed("environment-1"),
        stateDir: yield* fs.makeTempDirectoryScoped({ prefix: "t3-machines-test-" }),
        hosts: Effect.succeed(configured),
        setHosts: () => Effect.die("unused"),
        hostChanges: Stream.never,
        profiles: () => Effect.succeed(input.profiles),
        projectExists: (projectId) => Effect.sync(() => !harness.deletedProjects.has(projectId)),
        // ssh-keygen without the binary: writes a key pair where it was asked to.
        run: (_command, args) =>
          Effect.gen(function* () {
            const keyPath = args[args.indexOf("-f") + 1]!;
            yield* fs.writeFileString(keyPath, "PRIVATE");
            yield* fs.writeFileString(`${keyPath}.pub`, "ssh-ed25519 AAAAtest t3-code-machines\n");
            return { code: 0, stdout: "", stderr: "" };
          }).pipe(Effect.orDie),
      });
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
    Layer.provide(Layer.mergeAll(hostsLayer, platformLayer)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
}

const VM = profile({ name: "vm", type: "virtual-machine", diskSizesGiB: [4, 8] });
const CONTAINER = profile({ name: "box", type: "container" });

describe("MachineService", () => {
  it.effect("creates a VM with extra disks on its project's network", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [VM] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const fs = yield* FileSystem.FileSystem;
      const acquired = yield* machines.acquire({ ...BY, profile: "vm" });
      assert.strictEqual(acquired.name, "vm-1");
      assert.strictEqual(acquired.threadId, THREAD);

      const view = yield* machines.wait({ projectId: PROJECT, name: "vm-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "ready");
      assert.deepStrictEqual(view.diskSizesGiB, [4, 8]);
      assert.include(view.sshCommand, machines.sshConfigPath(PROJECT));

      const [instance] = [...fake.instances.values()];
      assert.isDefined(instance);
      const network = instance!.devices.eth0!.network!;
      assert.strictEqual(network, projectNetworkName(PROJECT));
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
      assert.strictEqual(instance!.config["user.t3.project"], PROJECT);
      assert.strictEqual(instance!.config["limits.memory"], "2GiB");
      assert.include(instance!.config["cloud-init.vendor-data"]!, "ssh-ed25519 AAAAtest");

      const config = yield* fs.readFileString(machines.sshConfigPath(PROJECT));
      assert.include(config, "Host vm-1\n");
      assert.include(config, "StrictHostKeyChecking yes");
      const knownHosts = yield* fs.readFileString(
        machines.sshConfigPath(PROJECT).replace(/ssh_config$/, "known_hosts"),
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
        yield* machines.acquire({ ...BY, profile: "vm" });
        const failed = yield* machines.wait({
          projectId: PROJECT,
          name: "vm-1",
          waitFor: "1 minute",
        });
        assert.strictEqual(failed.state, "failed");
        assert.include(failed.error!, "Insufficient resources");
        assert.strictEqual(fake.volumes.size, 2);

        yield* machines.release({ projectId: PROJECT, name: "vm-1" });
        assert.strictEqual(fake.volumes.size, 0);
        assert.strictEqual(fake.networks.size, 0);
        assert.deepStrictEqual(yield* machines.list(PROJECT), []);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("refuses what a project or host can't have", () => {
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
        yield* refusal(machines.acquire({ ...BY, profile: "nope" })),
        "unknown-profile",
      );
      assert.strictEqual(
        yield* refusal(machines.acquire({ ...BY, profile: "leaky" })),
        "extra-nic",
      );
      yield* machines.acquire({ ...BY, profile: "box" });
      // Names and the limit are the project's, whichever thread asks.
      const other = { projectId: PROJECT, threadId: OTHER_THREAD };
      assert.strictEqual(
        yield* refusal(machines.acquire({ ...other, profile: "box", name: "box-1" })),
        "name-taken",
      );
      for (let index = 0; index < 4; index++) {
        yield* machines.acquire({ ...other, profile: "box" });
      }
      assert.strictEqual(yield* refusal(machines.acquire({ ...BY, profile: "box" })), "limit");
      const elsewhere = yield* machines.acquire({
        projectId: OTHER_PROJECT,
        threadId: ThreadId.make("thread-3"),
        profile: "box",
        name: "box-1",
      });
      assert.strictEqual(elsewhere.name, "box-1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an LXD project that doesn't keep machines sandboxed", () => {
    const fake = makeFakeLxd({ projectConfig: { ...SANDBOXED_PROJECT, restricted: "false" } });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const error = yield* machines.acquire({ ...BY, profile: "box" }).pipe(Effect.flip);
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
      yield* machines.acquire({ ...BY, profile: "box" });
      yield* TestClock.adjust("11 minutes");
      const view = yield* machines.wait({ projectId: PROJECT, name: "box-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "failed");
      assert.include(view.error!, "didn't finish booting");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps a project's machines on one host and places new projects on the emptiest",
    () => {
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
        const first = yield* machines.acquire({ ...BY, profile: "box" });
        assert.strictEqual(first.hostLabel, "LXD empty");
        // Now `empty` has more instances, but the project's network is there.
        empty.instances.set("x", { ...busy.instances.get("other")!, name: "x" });
        const second = yield* machines.acquire({
          projectId: PROJECT,
          threadId: OTHER_THREAD,
          profile: "box",
        });
        assert.strictEqual(second.hostLabel, "LXD empty");
        empty.instances.set("y", { ...busy.instances.get("other")!, name: "y" });
        const elsewhere = yield* machines.acquire({
          projectId: OTHER_PROJECT,
          threadId: ThreadId.make("thread-3"),
          profile: "box",
        });
        assert.strictEqual(elsewhere.hostLabel, "LXD busy");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("releases machines whose lifetime is over", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({
      hosts: [["host-a", fake]],
      profiles: [profile({ name: "box", type: "container", lifetimeHours: 2 })],
    });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      yield* TestClock.adjust("1 hour");
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 1);
      yield* TestClock.adjust("1 hour");
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.strictEqual(fake.networks.size, 0);
      assert.deepStrictEqual(yield* machines.list(PROJECT), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops machines nobody used for 4 hours and starts them again on demand", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      const [instance] = [...fake.instances.values()];

      yield* TestClock.adjust("3 hours");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Running", "3 hours unused is not long enough");
      // A machine tool call counts as use.
      yield* machines.wait({ projectId: PROJECT, name: "box-1" });
      yield* TestClock.adjust("3 hours");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Running");
      yield* TestClock.adjust("1 hour");
      yield* machines.sweep;
      assert.strictEqual(instance!.status, "Stopped");
      assert.strictEqual((yield* machines.list(PROJECT))[0]!.state, "stopped");

      const woken = yield* machines.wait({
        projectId: PROJECT,
        name: "box-1",
        waitFor: "1 minute",
      });
      assert.strictEqual(woken.state, "ready");
    }).pipe(Effect.provide(layer));
  });

  it.effect("puts each project's machines on a network of its own", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box", name: "a" });
      yield* machines.acquire({ projectId: PROJECT, threadId: OTHER_THREAD, profile: "box" });
      yield* machines.acquire({
        projectId: OTHER_PROJECT,
        threadId: ThreadId.make("thread-3"),
        profile: "box",
      });
      const networkOf = (prefix: string, projectId: ProjectId) =>
        [...fake.instances.values()]
          .filter((instance) => instance.config["user.t3.project"] === projectId)
          .filter((instance) => instance.name.startsWith(prefix))
          .map((instance) => instance.devices.eth0?.network);
      assert.deepStrictEqual(
        [...networkOf("a-", PROJECT), ...networkOf("box-1-", PROJECT)],
        [projectNetworkName(PROJECT), projectNetworkName(PROJECT)],
      );
      assert.deepStrictEqual(networkOf("box-1-", OTHER_PROJECT), [
        projectNetworkName(OTHER_PROJECT),
      ]);
      assert.notStrictEqual(projectNetworkName(PROJECT), projectNetworkName(OTHER_PROJECT));
      for (const network of fake.networks.values()) {
        assert.strictEqual(network["security.acls"], "t3-machines");
        assert.strictEqual(network["security.acls.default.egress.action"], "reject");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("releases a deleted project's machines", () => {
    const fake = makeFakeLxd();
    const { harness, layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [VM] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "vm", waitFor: "1 minute" });
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 1);
      harness.deletedProjects.add(PROJECT);
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.strictEqual(fake.volumes.size, 0);
      assert.strictEqual(fake.networks.size, 0);
      // The ACL is shared by every project's network.
      assert.strictEqual(fake.acls.size, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("finishes releasing once a disconnected host is back", () => {
    const fake = makeFakeLxd();
    const { harness, layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      harness.hosts.delete("host-a");
      yield* machines.release({ projectId: PROJECT, name: "box-1" });
      assert.strictEqual(fake.instances.size, 1);
      assert.strictEqual((yield* machines.list(PROJECT))[0]!.state, "releasing");

      harness.hosts.set("host-a", fake);
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.deepStrictEqual(yield* machines.list(PROJECT), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never touches the machine of the state it was copied from", () => {
    const fake = makeFakeLxd();
    const real = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    // A dev server on copied state: same environment and projects, no leases.
    const copy = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      yield* MachineService.MachineService.pipe(
        Effect.flatMap((machines) =>
          machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" }),
        ),
        Effect.provide(real.layer),
      );
      const original = [...fake.instances.keys()];
      yield* Effect.gen(function* () {
        const machines = yield* MachineService.MachineService;
        const acquired = yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
        assert.strictEqual(acquired.state, "ready");
        yield* machines.release({ projectId: PROJECT, name: acquired.name });
      }).pipe(Effect.provide(copy.layer));
      assert.deepStrictEqual([...fake.instances.keys()], original);
    });
  });

  it.effect("deletes a machine whose creation LXD finishes after its release", () => {
    const accepted = Deferred.makeUnsafe<Parameters<LxdClient["createInstance"]>[0]>();
    const fake = makeFakeLxd({
      // LXD runs an accepted creation to the end, whether or not T3 still waits for it.
      onCreate: (post) => Deferred.succeed(accepted, post).pipe(Effect.andThen(Effect.never)),
    });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box" });
      const post = yield* Deferred.await(accepted);
      yield* machines.release({ projectId: PROJECT, name: "box-1" });
      assert.strictEqual((yield* machines.list(PROJECT))[0]!.state, "releasing");

      fake.instances.set(post.name, {
        name: post.name,
        type: post.type,
        status: "Running",
        config: post.config ?? {},
        devices: post.devices ?? {},
        probes: 0,
      });
      yield* machines.sweep;
      assert.strictEqual(fake.instances.size, 0);
      assert.deepStrictEqual(yield* machines.list(PROJECT), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up on a released machine LXD never finished creating", () => {
    const fake = makeFakeLxd({ onCreate: () => Effect.never });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box" });
      yield* machines.release({ projectId: PROJECT, name: "box-1" });
      yield* TestClock.adjust("10 minutes");
      yield* machines.sweep;
      assert.deepStrictEqual(yield* machines.list(PROJECT), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts a stopped machine once for connections that arrive together", () => {
    const starting = Deferred.makeUnsafe<void>();
    const finishStart = Deferred.makeUnsafe<void>();
    const fake = makeFakeLxd({
      onStart: Deferred.succeed(starting, undefined).pipe(
        Effect.andThen(Deferred.await(finishStart)),
      ),
    });
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      [...fake.instances.values()][0]!.status = "Stopped";
      const first = yield* Effect.forkChild(machines.wait({ projectId: PROJECT, name: "box-1" }));
      yield* Deferred.await(starting);
      const second = yield* Effect.forkChild(machines.wait({ projectId: PROJECT, name: "box-1" }));
      // The second either waits for the first's start or sends one of its own meanwhile.
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(finishStart, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(fake.calls.filter((call) => call.startsWith("start ")).length, 1);
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
          projectId: PROJECT,
          threadId: THREAD,
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
      const view = yield* machines.wait({ projectId: PROJECT, name: "box-1", waitFor: "1 minute" });
      assert.strictEqual(view.state, "ready");
    }).pipe(Effect.provide(layer));
  });

  it.effect("pushes a project's machines to its subscribers as they change", () => {
    const fake = makeFakeLxd();
    const { layer } = makeLayer({ hosts: [["host-a", fake]], profiles: [CONTAINER] });
    return Effect.gen(function* () {
      const machines = yield* MachineService.MachineService;
      const updates = yield* Queue.unbounded<ReadonlyArray<MachineView>>();
      yield* machines.subscribeProject(PROJECT).pipe(
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

      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      yield* next((update) => update[0]?.state === "ready");

      yield* machines.release({ projectId: PROJECT, name: "box-1" });
      yield* next((update) => update.length === 0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("lists and deletes machines the environment lost track of", () => {
    const fake = makeFakeLxd();
    const lostProject = "project-lost";
    const orphan = "lost-1-0000";
    fake.networks.set(projectNetworkName(lostProject), {});
    fake.volumes.set(`local/${orphan}-disk1`, 4);
    fake.instances.set(orphan, {
      name: orphan,
      type: "virtual-machine",
      status: "Running",
      config: {
        "user.t3.environment": "environment-1",
        "user.t3.project": lostProject,
        "user.t3.lease": "lease-lost",
      },
      devices: {
        eth0: { type: "nic", network: projectNetworkName(lostProject) },
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
      yield* machines.acquire({ ...BY, profile: "box", waitFor: "1 minute" });
      const leased = [...fake.instances.keys()].find((name) => name.startsWith("box-1-"))!;

      const inspection = yield* machines.inspectHosts;
      assert.strictEqual(inspection.hosts[0]?.status?.uplink, "uplink0");
      assert.deepStrictEqual(inspection.untracked, [
        {
          hostId: "host-a",
          instance: orphan,
          type: "virtual-machine",
          status: "Running",
          projectId: lostProject,
        },
      ]);

      // Neither a project's machine nor another environment's is deleted this way.
      for (const instance of [leased, "theirs"]) {
        const refusal = yield* machines
          .deleteUntracked({ hostId: "host-a", instance })
          .pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "MachineRefusedError");
      }

      yield* machines.deleteUntracked({ hostId: "host-a", instance: orphan });
      assert.deepStrictEqual([...fake.instances.keys()].toSorted(), [leased, "theirs"]);
      assert.isFalse(fake.volumes.has(`local/${orphan}-disk1`));
      assert.isFalse(fake.networks.has(projectNetworkName(lostProject)));
      assert.deepStrictEqual((yield* machines.inspectHosts).untracked, []);
    }).pipe(Effect.provide(layer));
  });
});
