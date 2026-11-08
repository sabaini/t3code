// @effect-diagnostics nodeBuiltinImport:off - A fake LXD needs a real TLS server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type WebSocket, WebSocketServer } from "ws";

import { makeLxdClient } from "./LxdClient.ts";

const selfSigned = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lxd-test-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
).pipe(
  Effect.map((directory) => {
    const certificate = NodePath.join(directory, "cert.pem");
    const key = NodePath.join(directory, "key.pem");
    NodeChildProcess.execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=lxd-test",
      "-keyout",
      key,
      "-out",
      certificate,
    ]);
    return {
      certificate: NodeFS.readFileSync(certificate, "utf8"),
      key: NodeFS.readFileSync(key, "utf8"),
    };
  }),
);

/**
 * Answers requests from `routes` by "METHOD path", in order, and records them. WebSocket upgrades
 * go to `onWebSocket` with the `secret` they carry.
 */
const fakeLxd = (
  tls: { readonly certificate: string; readonly key: string },
  routes: Record<string, Array<{ readonly status: number; readonly body: unknown }>>,
  onWebSocket?: (secret: string, socket: WebSocket) => void,
) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeHttps.Server; readonly seen: Array<string> }>(
      (resume) => {
        const seen: Array<string> = [];
        const server = NodeHttps.createServer(
          { cert: tls.certificate, key: tls.key, requestCert: true, rejectUnauthorized: false },
          (request, response) => {
            const route = `${request.method} ${new URL(request.url ?? "", "https://lxd").pathname}`;
            seen.push(route);
            const reply = routes[route]?.shift() ?? { status: 404, body: { type: "error" } };
            response.writeHead(reply.status, { "content-type": "application/json" });
            response.end(JSON.stringify(reply.body));
          },
        );
        new WebSocketServer({ server }).on("connection", (socket, request) => {
          const secret = new URL(request.url ?? "", "https://lxd").searchParams.get("secret");
          onWebSocket?.(secret ?? "", socket);
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, seen })));
      },
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

describe("LxdClient", () => {
  it.live("keeps waiting when LXD ends an operation wait with its deadline error", () =>
    Effect.gen(function* () {
      const tls = yield* selfSigned;
      const operation = "/1.0/operations/create-1";
      const lxd = yield* fakeLxd(tls, {
        "POST /1.0/instances": [{ status: 202, body: { type: "async", operation, metadata: {} } }],
        [`GET ${operation}/wait`]: [
          // What LXD 6 answers when the wait's own timeout passes first.
          {
            status: 500,
            body: { type: "error", error_code: 500, error: "context deadline exceeded" },
          },
          { status: 200, body: { type: "sync", metadata: { status_code: 200, err: "" } } },
        ],
      });
      const { port } = lxd.server.address() as NodeNet.AddressInfo;
      const client = yield* makeLxdClient(
        {
          address: `127.0.0.1:${port}`,
          serverCertificate: tls.certificate,
          clientCertificate: tls.certificate,
          clientKey: tls.key,
        },
        "t3-machines",
      );

      yield* client.createInstance({
        name: "box-1",
        type: "container",
        source: { type: "image", alias: "24.04" },
      });

      assert.deepStrictEqual(lxd.seen, [
        "POST /1.0/instances",
        `GET ${operation}/wait`,
        `GET ${operation}/wait`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps output the command writes as soon as its streams are connected", () =>
    Effect.gen(function* () {
      const tls = yield* selfSigned;
      const operation = "/1.0/operations/exec-1";
      const fds = { control: "control", "0": "stdin", "1": "stdout", "2": "stderr" };
      const sockets = new Map<string, WebSocket>();
      const lxd = yield* fakeLxd(
        tls,
        {
          "POST /1.0/instances/box/exec": [
            { status: 202, body: { type: "async", operation, metadata: { metadata: { fds } } } },
          ],
        },
        (secret, socket) => {
          sockets.set(secret, socket);
          if (sockets.size < 4) return;
          // sshd's banner, sent the moment LXD starts the command.
          sockets.get("stdout")!.send(new TextEncoder().encode("SSH-2.0-OpenSSH_9.6\r\n"));
          sockets.get("stdout")!.close();
          sockets.get("stderr")!.close();
        },
      );
      const { port } = lxd.server.address() as NodeNet.AddressInfo;
      const client = yield* makeLxdClient(
        {
          address: `127.0.0.1:${port}`,
          serverCertificate: tls.certificate,
          clientCertificate: tls.certificate,
          clientKey: tls.key,
        },
        "t3-machines",
      );

      const exec = yield* client.exec("box", ["nc", "-q0", "127.0.0.1", "22"]);
      const output = yield* Stream.mkString(Stream.decodeText(exec.stdout));
      assert.strictEqual(output, "SSH-2.0-OpenSSH_9.6\r\n");
    }).pipe(Effect.scoped),
  );
});
