// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetch:off globalConsole:off globalConsoleInEffect:off globalTimers:off preferSchemaOverJson:off globalJsonInEffect:off - Manual live verifier: prints a timeline for a person watching it.
/**
 * Manual end-to-end run against a real LXD server and real (paid) agents; never runs in CI.
 *   lxc config trust add --name t3-e2e --restricted --projects <project> --quiet > token
 *   node scripts/machines-e2e-live.ts token <project>
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MachineProfile,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type MachineView,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const [tokenFile, lxdProject = "t3-machines"] = process.argv.slice(2);
if (tokenFile === undefined) {
  console.error("Usage: node scripts/machines-e2e-live.ts <trust-token-file> [lxd-project]");
  process.exit(2);
}
const CLAUDE_MODEL = process.env.E2E_CLAUDE_MODEL ?? "claude-sonnet-5-5";
const CODEX_MODEL = process.env.E2E_CODEX_MODEL ?? "gpt-6-astra";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-machines-e2e-"));
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
NodeFS.mkdirSync(project);
NodeChildProcess.execFileSync("git", ["init", "-q", project]);
NodeChildProcess.execFileSync("git", [
  "-C",
  project,
  "-c",
  "user.name=Verifier",
  "-c",
  "user.email=verifier@localhost",
  "commit",
  "--allow-empty",
  "-qm",
  "initial",
]);
console.log(`Evidence: ${evidence}`);

const started = Date.now();
const step = (text: string) => {
  const seconds = Math.round((Date.now() - started) / 1000);
  const line = `[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${text}`;
  console.log(line);
  NodeFS.appendFileSync(NodePath.join(evidence, "timeline.txt"), line + "\n");
};

const lxcJson = (args: ReadonlyArray<string>): unknown =>
  JSON.parse(
    NodeChildProcess.execFileSync("lxc", [...args, "--project", lxdProject, "-f", "json"], {
      encoding: "utf8",
    }),
  );
const lxdInstances = () =>
  (lxcJson(["list"]) as Array<{ name: string; status: string; type: string }>).map(
    (instance) => `${instance.name}:${instance.status}`,
  );
const lxdVolumes = () =>
  (lxcJson(["storage", "volume", "list", "local"]) as Array<{ name: string; type: string }>)
    .filter((volume) => volume.type === "custom")
    .map((volume) => volume.name);
const lxdNetworks = () =>
  (lxcJson(["network", "list"]) as Array<{ name: string; managed: boolean; type: string }>)
    .filter((network) => network.type === "ovn")
    .map((network) => network.name);
const lxdTrustNames = () =>
  (
    JSON.parse(
      NodeChildProcess.execFileSync("lxc", ["config", "trust", "list", "-f", "json"], {
        encoding: "utf8",
      }),
    ) as Array<{ name: string }>
  ).map((entry) => entry.name);
/** Networks go after their last machine, just after clients hear it's gone. */
const lxdEmpty = Effect.fn("MachinesE2e.lxdEmpty")(function* (label: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const snapshot = lxdSnapshot(label, attempt === 0);
    if (snapshot.instances.length + snapshot.volumes.length + snapshot.networks.length === 0)
      return;
    yield* Effect.sleep("1 second");
  }
  lxdSnapshot(label);
  return yield* Effect.die(new Error(`${label}: LXD still has machines, disks or networks`));
});
const lxdSnapshot = (label: string, print = true) => {
  const snapshot = {
    instances: lxdInstances(),
    volumes: lxdVolumes(),
    networks: lxdNetworks(),
  };
  if (print) step(`  LXD ${label}: ${JSON.stringify(snapshot)}`);
  return snapshot;
};

NodeAssert.deepEqual(
  lxdSnapshot("before"),
  { instances: [], volumes: [], networks: [] },
  `The LXD project ${lxdProject} must start empty`,
);
const trustBefore = lxdTrustNames();

const hostAddresses = NodeChildProcess.execFileSync(
  "ip",
  ["-4", "-o", "addr", "show", "scope", "global"],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .map((line) => line.trim().split(/\s+/)[3]?.split("/")[0])
  .filter((address): address is string => address !== undefined);

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

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();

const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
  { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] },
);
step(`Server pid ${server.pid} on ${origin}`);
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
bootstrapPipe.on("error", () => {});
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const ready = Promise.withResolvers<void>();
let tail = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
    tail = (tail + text).slice(-8192);
    if (tail.includes("startup phase: complete")) ready.resolve();
  });
server.once("error", ready.reject);
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  90_000,
);

/** Async: the relay that ssh's proxy reaches runs in the server. */
const ssh = (sshCommand: string, command: string) =>
  Effect.promise(
    () =>
      new Promise<{ code: number; output: string }>((resolve) => {
        const [, ...args] = sshCommand.split(" ");
        NodeChildProcess.execFile(
          "ssh",
          [...args, command],
          { timeout: 240_000, encoding: "utf8" },
          (error, stdout, stderr) =>
            resolve({
              code: error ? (typeof error.code === "number" ? error.code : 255) : 0,
              output: `${stdout}${stderr}`.trim(),
            }),
        );
      }),
  );

const summarize = (machines: ReadonlyArray<MachineView>) =>
  machines.map((machine) => `${machine.name}:${machine.state}`).join(", ") || "(none)";

let failed = false;
try {
  await ready.promise;
  clearTimeout(startupDeadline);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Machines e2e",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);

    const waitMachines = (
      description: string,
      predicate: (machines: ReadonlyArray<MachineView>) => boolean,
      timeout: Duration.Input = "6 minutes",
    ) =>
      client["machines.subscribeProject"]({ projectId }).pipe(
        Stream.map((state) => state.machines),
        Stream.filter(predicate),
        Stream.runHead,
        Effect.timeoutOption(timeout),
        Effect.map(Option.flatten),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error(`Timed out waiting for ${description}`)),
            onSome: Effect.succeed,
          }),
        ),
        Effect.tap((machines) =>
          Effect.sync(() => step(`  Saw ${description}: ${summarize(machines)}`)),
        ),
      );

    const watchMachines = (label: string) => {
      let last = "";
      return client["machines.subscribeProject"]({ projectId }).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            const summary = summarize(state.machines);
            NodeFS.appendFileSync(
              NodePath.join(evidence, `machines-${label}.ndjson`),
              JSON.stringify({ at: new Date().toISOString(), machines: state.machines }) + "\n",
            );
            if (summary === last) return;
            last = summary;
            step(`  [${label} panel] ${summary}`);
          }),
        ),
        Effect.forkScoped,
      );
    };

    const runTurn = (threadId: ThreadId, label: string) => {
      let lastStatus = "";
      return client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.mapEffect((item) =>
          item.kind === "snapshot"
            ? Effect.succeed(item.projection)
            : client["orchestration.getThreadProjection"]({ threadId }),
        ),
        Stream.map((projection: OrchestrationV2ThreadProjection) => {
          NodeFS.writeFileSync(
            NodePath.join(evidence, `projection-${label}.json`),
            JSON.stringify(projection, null, 2),
          );
          const status = projection.runs.map((run) => run.status).join(",");
          if (status !== lastStatus) {
            lastStatus = status;
            step(`  [${label} turn] ${status || "(no run yet)"}`);
          }
          return projection;
        }),
        Stream.filter(
          (projection) =>
            projection.runs.length > 0 &&
            projection.runs.every((run) =>
              ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                run.status,
              ),
            ),
        ),
        Stream.runHead,
        Effect.timeoutOption("20 minutes"),
        Effect.map(Option.flatten),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(new Error(`${label}'s turn didn't finish`)),
            onSome: Effect.succeed,
          }),
        ),
      );
    };

    const dispatch = (type: "thread.archive", threadId: ThreadId) =>
      client["orchestration.dispatchCommand"]({
        type,
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
      });

    const launch = (threadId: ThreadId, instanceId: string, model: string, prompt: string) =>
      client["orchestration.launchThread"]({
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId,
        title: `Machines e2e: ${instanceId}`,
        modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: prompt, attachments: [] },
      });

    const lastAssistantText = (projection: OrchestrationV2ThreadProjection) =>
      projection.messages.findLast((message) => message.role === "assistant")?.text ?? "";

    // 1. Connect the LXD server, as Settings does.
    step("Connecting the LXD server");
    const trustToken = NodeFS.readFileSync(tokenFile, "utf8").trim();
    NodeFS.rmSync(tokenFile);
    const host = yield* client["machines.connectHost"]({ trustToken, label: "e2e" });
    step(`  Connected ${host.label} (${host.hostId})`);
    const inspection = yield* client["machines.inspectHosts"]({});
    NodeFS.writeFileSync(
      NodePath.join(evidence, "inspection-start.json"),
      JSON.stringify(inspection, null, 2),
    );
    const status = inspection.hosts[0]?.status;
    step(
      `  Host status: ${JSON.stringify({ server: status?.serverName, version: status?.version, supported: status?.versionSupported, types: status?.instanceTypes, uplink: status?.uplink, missing: status?.missing, unsafe: status?.unsafe, error: inspection.hosts[0]?.error, untracked: inspection.untracked.length })}`,
    );
    NodeAssert.ok(status?.versionSupported, "LXD server version unsupported");
    NodeAssert.deepEqual([...status.missing, ...status.unsafe], [], "Project isn't safe");

    // 2. Profiles and agent access, as Settings does.
    yield* client["server.updateSettings"]({
      patch: { enableAgentMachineAccess: true, machineProfiles: profiles },
    });
    step("Saved profiles box (container) and vm (VM, one 3 GiB disk); agent access on");

    // 3. A Claude thread creates and uses two machines.
    const claude = ThreadId.make(NodeCrypto.randomUUID());
    yield* watchMachines("project");
    step(`Launching Claude (${CLAUDE_MODEL}) thread ${claude}`);
    yield* launch(
      claude,
      "claudeAgent",
      CLAUDE_MODEL,
      [
        "This is a live test of T3 Code's machine tools. Use the T3 machine tools, not lxc or anything else.",
        "1. List the machine profiles.",
        "2. Create one machine from the profile `box` and one from the profile `vm`, and wait until both are ready.",
        "3. Over ssh, with the ssh command the tools give you, run `hostname && uname -r && lsblk -dn -o NAME,SIZE,TYPE` on each.",
        "4. From the box machine, ping the vm machine once by the name its peers reach it by.",
        "Don't release the machines; leave them running. Reply with a short summary of each step's result and end with the line E2E_DONE.",
      ].join("\n"),
    );
    const claudeTurn = yield* runTurn(claude, "claude");
    const claudeReply = lastAssistantText(claudeTurn);
    step(`  Claude replied:\n${claudeReply.replace(/^/gm, "    | ")}`);
    NodeAssert.equal(claudeTurn.runs.at(-1)?.status, "completed", "Claude's turn didn't complete");
    NodeAssert.ok(claudeReply.includes("E2E_DONE"), "Claude didn't finish the task");

    const machines = yield* waitMachines(
      "two running machines",
      (list) => list.length === 2 && list.every((machine) => machine.state === "ready"),
      "1 minute",
    );
    const box = machines.find((machine) => machine.profile === "box");
    const vm = machines.find((machine) => machine.profile === "vm");
    NodeAssert.ok(box && vm, "Expected a box and a vm machine");
    lxdSnapshot("with two machines");

    // 4. What the user's "Open terminal" runs, and what machines can reach.
    step(`Checking machines myself with ${box.sshCommand}`);
    const checks = [
      [vm, "lsblk -dn -o NAME,SIZE,TYPE | grep -c ' 3G disk'", (out: string) => out === "1"],
      [
        box,
        `ping -c1 -W3 ${vm.dnsName} >/dev/null && echo reached`,
        (out: string) => out === "reached",
      ],
      [
        box,
        "curl -s -o /dev/null -m 10 -w '%{http_code}' https://cloud-images.ubuntu.com/",
        (out: string) => /^[23]\d\d$/.test(out),
      ],
      ...hostAddresses.map(
        (address) =>
          [
            box,
            `timeout 5 bash -c 'exec 3<>/dev/tcp/${address}/8443' 2>/dev/null && echo open || echo blocked`,
            (out: string) => out === "blocked",
          ] as const,
      ),
      [
        box,
        "curl -s -m 5 http://169.254.169.254/ >/dev/null && echo open || echo blocked",
        (out: string) => out === "blocked",
      ],
    ] as const;
    for (const [machine, command, ok] of checks) {
      const result = yield* ssh(machine.sshCommand, command);
      const passed = result.code === 0 && ok(result.output);
      step(
        `  ${passed ? "ok  " : "FAIL"} ${machine.name}: ${command} → ${result.output || `exit ${result.code}`}`,
      );
      NodeAssert.ok(passed, `Check failed on ${machine.name}: ${command}`);
    }

    // 5. Machines are the project's: archiving the thread that made them leaves them.
    step("Archiving the Claude thread");
    yield* dispatch("thread.archive", claude);
    const kept = yield* waitMachines("both still there", (list) => list.length === 2, "1 minute");
    NodeAssert.ok(kept.every((machine) => machine.threadId === claude));

    // 6. ssh starts a stopped machine again.
    step(`Stopping ${box.name} on LXD, then ssh to it`);
    NodeChildProcess.execFileSync("lxc", [
      "stop",
      box.dnsName.replace(/\.lxd$/, ""),
      "--project",
      lxdProject,
    ]);
    yield* waitMachines(`${box.name} stopped`, (list) =>
      list.some((machine) => machine.name === box.name && machine.state === "stopped"),
    );
    const again = yield* ssh(box.sshCommand, "uptime -p");
    step(`  ${box.name}: exit ${again.code}: ${again.output}`);
    NodeAssert.equal(again.code, 0, "ssh didn't start the stopped machine");
    yield* waitMachines(`${box.name} running again`, (list) =>
      list.some((machine) => machine.name === box.name && machine.state === "ready"),
    );

    // 7. A Codex thread of the project uses Claude's machine, and releases only its own.
    const codex = ThreadId.make(NodeCrypto.randomUUID());
    step(`Launching Codex (${CODEX_MODEL}) thread ${codex}`);
    yield* launch(
      codex,
      "codex",
      CODEX_MODEL,
      [
        "This is a live test of T3 Code's machine tools. Use the T3 machine tools, not lxc or anything else.",
        `1. Run \`hostname\` on the existing machine ${box.name} over ssh, with the ssh command the tools give you.`,
        "2. Create one machine from the profile `box`, run `head -1 /etc/os-release` on it over ssh, and release it with the machine tools when you're done.",
        "Reply with both outputs and end with the line E2E_DONE.",
      ].join("\n"),
    );
    const codexTurn = yield* runTurn(codex, "codex");
    const codexReply = lastAssistantText(codexTurn);
    step(`  Codex replied:\n${codexReply.replace(/^/gm, "    | ")}`);
    NodeAssert.equal(codexTurn.runs.at(-1)?.status, "completed", "Codex's turn didn't complete");
    NodeAssert.ok(codexReply.includes("E2E_DONE"), "Codex didn't finish the task");
    const afterCodex = yield* waitMachines(
      "Claude's two machines and none of Codex's",
      (list) => list.length === 2 && list.every((machine) => machine.threadId === claude),
      "1 minute",
    );
    NodeAssert.equal(afterCodex.length, 2);

    // 8. The user releases them from the panel, which any thread of the project shows.
    for (const machine of [vm, box]) {
      step(`Releasing ${machine.name} as the panel does`);
      yield* client["machines.release"]({ projectId, name: machine.name });
    }
    yield* waitMachines("no machines", (list) => list.length === 0);
    yield* lxdEmpty("after releasing");
    yield* dispatch("thread.archive", codex);

    // 9. Nothing untracked; disconnecting removes T3 Code's certificate.
    const finalInspection = yield* client["machines.inspectHosts"]({});
    step(`Untracked machines: ${finalInspection.untracked.length}`);
    NodeAssert.equal(finalInspection.untracked.length, 0);
    const disconnected = yield* client["machines.disconnectHost"]({ hostId: host.hostId });
    step(`Disconnected: ${JSON.stringify(disconnected)}`);
    NodeAssert.equal(disconnected.manualCommand, undefined, "Disconnect left the certificate");
    NodeAssert.deepEqual(lxdTrustNames().toSorted(), trustBefore.toSorted(), "Trust list changed");
    const afterDisconnect = yield* client["machines.inspectHosts"]({});
    NodeAssert.equal(afterDisconnect.hosts.length, 0, "Host still listed after disconnect");
    step("Certificate gone from LXD's trust list; no hosts left");
  }).pipe(Effect.scoped, Effect.provide(layerProtocol));
  await Effect.runPromise(program);
  step("PASSED");
} catch (error) {
  failed = true;
  step(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise<void>((done) => server.once("exit", () => done()));
    server.kill("SIGTERM");
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await stopped;
    clearTimeout(deadline);
  }
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        console.error(error);
        failed = true;
      }
    }
  }
  step(
    `Server stopped. Trust entries now: ${
      lxdTrustNames()
        .filter((name) => !trustBefore.includes(name))
        .join(", ") || "(none new)"
    }`,
  );
  process.exitCode = failed ? 1 : 0;
}
