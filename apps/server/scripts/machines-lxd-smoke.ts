// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off globalConsoleInEffect:off - Manual verifier: prints timings and raw ssh output for a person watching it.
/**
 * Manual smoke test against a real LXD server; never runs in CI.
 *   lxc config trust add --name t3-smoke --restricted --projects <project> --quiet > token
 *   node scripts/machines-lxd-smoke.ts token
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, MachineProfile, ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as MachineHosts from "../src/machines/MachineHosts.ts";
import * as MachineLeaseStore from "../src/machines/MachineLeaseStore.ts";
import * as MachineService from "../src/machines/MachineService.ts";
import * as MachineThreads from "../src/machines/MachineThreads.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as Settings from "../src/serverSettings.ts";

const tokenFile = process.argv[2];
if (tokenFile === undefined) {
  console.error("Usage: node scripts/machines-lxd-smoke.ts <trust-token-file>");
  process.exit(2);
}

const THREAD = ThreadId.make(`smoke-${Date.now()}`);
const decodeProfile = Schema.decodeSync(MachineProfile);
const profiles = [
  decodeProfile({ name: "box", image: "ubuntu:24.04", type: "container", cpus: 1, memoryGiB: 1 }),
  decodeProfile({
    name: "vm",
    image: "ubuntu:24.04",
    type: "virtual-machine",
    cpus: 2,
    memoryGiB: 2,
    diskSizesGiB: [3],
  }),
];

/** Async: the relay that ssh's proxy reaches runs in this process. */
const ssh = (configPath: string, name: string, command: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "ssh",
          ["-F", configPath, name, command],
          { encoding: "utf8", timeout: 120_000 },
          (error, stdout, stderr) => {
            console.log(`$ ssh ${name} ${JSON.stringify(command)} -> ${error?.code ?? 0}`);
            console.log((stdout + stderr).trim().replace(/^/gm, "  "));
            if (error) reject(new Error(`ssh to ${name} failed`));
            else resolve(stdout);
          },
        );
      }),
  );

const program = Effect.gen(function* () {
  const hosts = yield* MachineHosts.MachineHosts;
  const machines = yield* MachineService.MachineService;
  const host = yield* hosts.connect({
    trustToken: NodeFS.readFileSync(tokenFile, "utf8"),
    label: "smoke",
  });
  console.log(`Connected ${host.label} (${host.address}, project ${host.project}) as ${host.id}`);
  console.log(yield* hosts.status(host.id));
  try {
    const started = Date.now();
    const box = yield* machines.acquire({
      threadId: THREAD,
      profile: "box",
      waitFor: "10 minutes",
    });
    console.log(
      `box: ${box.state} after ${Math.round((Date.now() - started) / 1000)}s`,
      box.error ?? "",
    );
    const configPath = machines.sshConfigPath(THREAD);
    yield* ssh(configPath, box.name, "hostname; uname -r; ip -4 -br addr show eth0");
    // The sandbox: the public internet is reachable, the LAN and the LXD host aren't.
    const internet = yield* ssh(
      configPath,
      box.name,
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://cloud-images.ubuntu.com/",
    );
    if (internet.trim() !== "200") throw new Error("The public internet isn't reachable");
    const lanHost = host.address.replace(/:\d+$/, "");
    const lan = yield* ssh(
      configPath,
      box.name,
      `curl -sS -o /dev/null --max-time 5 https://${lanHost}:8443/ && echo reached || echo blocked`,
    );
    if (!lan.includes("blocked")) throw new Error("A machine reached the LAN");

    const vmStarted = Date.now();
    const vm = yield* machines.acquire({ threadId: THREAD, profile: "vm", waitFor: "10 minutes" });
    console.log(
      `vm: ${vm.state} after ${Math.round((Date.now() - vmStarted) / 1000)}s`,
      vm.error ?? "",
    );
    const disks = yield* ssh(configPath, vm.name, "lsblk -dno NAME,SIZE,TYPE");
    if (!/3G/.test(disks)) throw new Error("The VM's extra disk is missing");
    // Machines of one thread reach each other by DNS name.
    yield* ssh(configPath, vm.name, `ping -c1 -W5 ${box.dnsName} | head -2`);

    // Settling stops the thread's machines; ssh starts one again.
    thread.settled = true;
    yield* machines.reconcileThread(THREAD);
    console.log(
      (yield* machines.list(THREAD)).map((machine) => `${machine.name}: ${machine.state}`),
    );
    thread.settled = false;
    const wakeStarted = Date.now();
    yield* ssh(configPath, vm.name, "uptime");
    console.log(`vm woke for ssh in ${Math.round((Date.now() - wakeStarted) / 1000)}s`);
    console.log(
      (yield* machines.list(THREAD)).map((machine) => `${machine.name}: ${machine.state}`),
    );
  } finally {
    for (const machine of yield* machines.list(THREAD).pipe(Effect.orElseSucceed(() => []))) {
      yield* machines.release({ threadId: THREAD, name: machine.name });
      console.log(`released ${machine.name}`);
    }
    console.log(yield* hosts.disconnect(host.id));
  }
});

const thread = { settled: false };
const threadsLayer = Layer.succeed(
  MachineThreads.MachineThreads,
  MachineThreads.MachineThreads.of({
    get: Effect.fn("MachineThreads.MachineThreads.get")(() =>
      Effect.sync(() =>
        Option.some({
          projectId: ProjectId.make("smoke"),
          archived: false,
          settled: thread.settled,
          running: !thread.settled,
          lastTurnAt: Date.now(),
        }),
      ),
    ),
    lifecycleChanges: Stream.never,
  }),
);

const layer = MachineService.layer.pipe(
  Layer.provideMerge(MachineHosts.layer),
  Layer.provide(
    Layer.mergeAll(
      MachineLeaseStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
      threadsLayer,
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("smoke")),
          getDescriptor: Effect.die("unused"),
        }),
      ),
    ),
  ),
  Layer.provideMerge(Settings.ServerSettingsService.layerTest({ machineProfiles: profiles })),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machines-smoke-" })),
  Layer.provide(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

await Effect.runPromise(
  program.pipe(
    Effect.provide(layer),
    // ssh's ProxyCommand runs the server's entrypoint, not this script.
    Effect.provideService(HostProcess.Arguments, [
      process.execPath,
      NodePath.resolve(import.meta.dirname, "../src/bin.ts"),
    ]),
    Effect.scoped,
  ),
);
