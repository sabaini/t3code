// @effect-diagnostics nodeBuiltinImport:off - Unix socket servers have no Effect API.
import * as NodeNet from "node:net";

import * as NodeStream from "@effect/platform-node/NodeStream";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { LxdExec } from "./lxd/LxdClient.ts";
import { MachinePlatform } from "./MachinePlatform.ts";

export class MachineSshError extends Schema.TaggedError<MachineSshError>()("MachineSshError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Couldn't ${this.operation} for machines.`;
  }
}

/** Inside the machine: LXD exec reaches sshd whether LXD is local or remote, without a route to its network. */
export const MACHINE_SSH_RELAY_COMMAND = ["nc", "-N", "127.0.0.1", "22"] as const;
const MACHINE_SSH_USER = "ubuntu";

/**
 * One key for the environment's machines. Agents all run as the same user as
 * the server, so keys per project wouldn't keep projects from each other's machines.
 */
export const ensureMachineSshKey = Effect.fn("MachineSsh.ensureKey")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* MachinePlatform;
  const keyPath = path.join(directory, "id_ed25519");
  const failed = (operation: string) => (cause: unknown) =>
    new MachineSshError({ operation, cause });
  const exists = yield* fs
    .exists(`${keyPath}.pub`)
    .pipe(Effect.mapError(failed("check the SSH key")));
  if (!exists) {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failed("create the SSH key directory")));
    // A private key without its public half is from an interrupted run.
    yield* fs.remove(keyPath, { force: true }).pipe(Effect.mapError(failed("replace the SSH key")));
    const result = yield* platform
      .run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t3-code-machines", "-f", keyPath])
      .pipe(Effect.mapError(failed("create the SSH key")));
    if (result.code !== 0) {
      return yield* failed("create the SSH key")(new Error(result.stderr.slice(0, 500)));
    }
  }
  const publicKey = yield* fs
    .readFileString(`${keyPath}.pub`)
    .pipe(Effect.mapError(failed("read the SSH key")));
  return { keyPath, publicKey: publicKey.trim() };
});

/** ssh's ProxyCommand, which reaches the server's relay socket for a machine through this binary's fast path. */
export const writeMachineSshProxy = Effect.fn("MachineSsh.writeProxy")(function* (
  proxyPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const invocation = yield* resolveSelfInvocation();
  const command = [invocation.command, ...selfInvocationArgs(invocation, ["machine-ssh-proxy"])]
    .map((value) => "'" + value.replaceAll("'", "'\"'\"'") + "'")
    .join(" ");
  // The desktop app's binary is Electron, which runs as Node only when told to.
  const script = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${command} "$1"\n`;
  yield* fs.writeFileString(proxyPath, script, { mode: 0o755 }).pipe(
    Effect.andThen(fs.chmod(proxyPath, 0o755)),
    Effect.mapError((cause) => new MachineSshError({ operation: "write ssh's proxy", cause })),
  );
});

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Offers machines only their key: sshd gives up after six it doesn't know,
 * and the user's agent may hold more. Host keys are pinned per machine.
 */
export function machineSshConfig(input: {
  readonly machines: ReadonlyArray<{ readonly name: string; readonly socketPath: string }>;
  readonly keyPath: string;
  readonly knownHostsPath: string;
  readonly proxyPath: string;
}): string {
  const hosts = input.machines.map(
    (machine) => `Host ${machine.name}
    User ${MACHINE_SSH_USER}
    IdentityFile ${quote(input.keyPath)}
    IdentitiesOnly yes
    IdentityAgent none
    ProxyCommand ${quote(input.proxyPath)} ${quote(machine.socketPath)}
    HostKeyAlias ${machine.name}
    UserKnownHostsFile ${quote(input.knownHostsPath)}
    GlobalKnownHostsFile none
    KnownHostsCommand none
    StrictHostKeyChecking yes
    CheckHostIP no
`,
  );
  return `# This project's machines. T3 Code rewrites this file as they come and go.\n${hosts.join("")}`;
}

/**
 * Serves a relay socket until the scope closes, which also cuts open
 * connections: closing alone would wait for them.
 */
export const serveRelaySocket = Effect.fn("MachineSsh.serveRelaySocket")(function* <E>(
  socketPath: string,
  onConnection: (socket: NodeNet.Socket) => Effect.Effect<void, E>,
) {
  const fs = yield* FileSystem.FileSystem;
  const run = yield* FiberSet.makeRuntime<never, void, E>();
  const clients = new Set<NodeNet.Socket>();
  yield* fs.remove(socketPath, { force: true }).pipe(Effect.ignore);
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server, MachineSshError>((resume) => {
      // Each direction ends on its own: ssh finishing sending doesn't end the machine's reply.
      const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        clients.add(socket);
        socket.once("close", () => clients.delete(socket));
        // Reads and writes report their own failures; without a listener they'd crash the process.
        socket.on("error", () => undefined);
        run(onConnection(socket).pipe(Effect.ensuring(Effect.sync(() => socket.destroy()))));
      });
      server.once("error", (cause) =>
        resume(Effect.fail(new MachineSshError({ operation: "open a relay socket", cause }))),
      );
      server.listen(socketPath, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of clients) client.destroy();
        server.close(() => resume(Effect.void));
      }).pipe(Effect.andThen(fs.remove(socketPath, { force: true })), Effect.ignore),
  );
  yield* fs
    .chmod(socketPath, 0o600)
    .pipe(
      Effect.mapError(
        (cause) => new MachineSshError({ operation: "secure a relay socket", cause }),
      ),
    );
  return server;
});

const writeSocket = (socket: NodeNet.Socket, chunk: Uint8Array) =>
  Effect.callback<void>((resume) => {
    socket.write(chunk, () => resume(Effect.void));
  });

/** How much of what nc writes to stderr is kept to explain a failed connection. */
const STDERR_KEPT_CHARS = 2_000;

/** Joins an ssh connection to `nc` in the machine. Resolves with nc's exit code and the start of its stderr. */
export const relaySshConnection = Effect.fn("MachineSsh.relay")(function* (
  socket: NodeNet.Socket,
  exec: LxdExec,
) {
  const toMachine = NodeStream.fromReadable<Uint8Array, MachineSshError>({
    evaluate: () => socket,
    closeOnDone: false,
    onError: (cause) => new MachineSshError({ operation: "read from ssh", cause }),
  }).pipe(Stream.runForEach(exec.write), Effect.ensuring(exec.closeStdin));
  const toClient = Stream.runForEach(exec.stdout, (chunk) => writeSocket(socket, chunk)).pipe(
    // Without an end, ssh would wait for the rest of the reply.
    Effect.andThen(Effect.sync(() => socket.end())),
  );
  const stderr = Stream.runFold(
    exec.stderr,
    () => "",
    (kept, chunk) =>
      kept.length >= STDERR_KEPT_CHARS ? kept : kept + new TextDecoder().decode(chunk),
  );
  const [, , errorText] = yield* Effect.all([toMachine, toClient, stderr], {
    concurrency: "unbounded",
  });
  const exitCode = yield* exec.exitCode;
  return { exitCode, stderr: errorText.slice(0, STDERR_KEPT_CHARS).trim() };
});
