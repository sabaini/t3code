// @effect-diagnostics-next-line nodeBuiltinImport:off -- The shell itself checks how it splits a quoted path.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { LxdExec } from "./lxd/LxdClient.ts";
import { relaySshConnection, serveRelaySocket, shellWord } from "./MachineSsh.ts";

/** Stands in for `nc` in the machine: answers in upper case, and exits once its input ends. */
const upperCaseExec = Effect.gen(function* () {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const exited = yield* Deferred.make<number>();
  return {
    write: (chunk) =>
      Queue.offer(
        output,
        new TextEncoder().encode(new TextDecoder().decode(chunk).toUpperCase()),
      ).pipe(Effect.asVoid),
    closeStdin: Queue.end(output).pipe(Effect.andThen(Deferred.succeed(exited, 0)), Effect.asVoid),
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    exitCode: Deferred.await(exited),
  } satisfies LxdExec;
});

/** Sends `text`, ends its side, and reads the reply until the relay ends the other. */
const exchange = (socketPath: string, text: string) =>
  Effect.callback<string, Error>((resume) => {
    const socket = NodeNet.createConnection({ path: socketPath, allowHalfOpen: true });
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
    socket.on("end", () => {
      socket.destroy();
      resume(Effect.succeed(reply));
    });
    socket.on("error", (error) => resume(Effect.fail(error)));
    socket.write(text, () => socket.end());
  });

it.each([
  "/home/user/.t3/userdata/machines/p/0123abcd/ssh_config",
  "/Users/user/Library/Application Support/t3/ssh_config",
  "/tmp/it's here/ssh_config",
])("passes %s to the shell as one word", (path) => {
  const words = NodeChildProcess.execFileSync("sh", ["-c", `printf '%s\\0' ${shellWord(path)}`], {
    encoding: "utf8",
  });
  assert.deepStrictEqual(words.split("\0").slice(0, -1), [path]);
});

describe("SSH relay", () => {
  it.live("carries bytes both ways and lets the client end its side first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-" });
      const socketPath = path.join(directory, "machine.sock");
      const exitCodes = yield* Queue.unbounded<number>();
      yield* serveRelaySocket(socketPath, (socket) =>
        upperCaseExec.pipe(
          Effect.flatMap((exec) => relaySshConnection(socket, exec)),
          Effect.flatMap((result) => Queue.offer(exitCodes, result.exitCode)),
          Effect.orDie,
        ),
      );
      assert.strictEqual((yield* fs.stat(socketPath)).mode & 0o777, 0o600);
      assert.strictEqual(yield* exchange(socketPath, "ssh-2.0 hello"), "SSH-2.0 HELLO");
      assert.strictEqual(yield* Queue.take(exitCodes), 0);
      // Each connection gets its own command.
      assert.strictEqual(yield* exchange(socketPath, "again"), "AGAIN");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
