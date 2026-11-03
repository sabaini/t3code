// @effect-diagnostics nodeBuiltinImport:off - the fixture is a raw HTTPS server with openssl-made certificates.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { loadUndici, makePinnedAgent } from "./LxdTls.ts";

const scratchDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lxd-tls-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

/** A self-signed `CA:FALSE` leaf like the ones LXD serves. */
const selfSignedLeaf = (directory: string, name: string) => {
  const keyPath = NodePath.join(directory, `${name}.key`);
  const certificatePath = NodePath.join(directory, `${name}.crt`);
  NodeChildProcess.execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:secp384r1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ]);
  return {
    certificate: NodeFS.readFileSync(certificatePath, "utf8"),
    key: NodeFS.readFileSync(keyPath, "utf8"),
  };
};

const listen = (credentials: { certificate: string; key: string }) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttps.Server>((resume) => {
      const server = NodeHttps.createServer(
        // LXD takes any client certificate at the TLS layer and authorizes it per request.
        {
          cert: credentials.certificate,
          key: credentials.key,
          requestCert: true,
          rejectUnauthorized: false,
        },
        (_request, response) => response.end("ok"),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

describe("makePinnedAgent", () => {
  it.live("trusts only the pinned self-signed certificate", () =>
    Effect.gen(function* () {
      const directory = yield* scratchDirectory;
      const served = selfSignedLeaf(directory, "server");
      const client = selfSignedLeaf(directory, "client");
      const other = selfSignedLeaf(directory, "other");
      const server = yield* listen(served);
      const address = `127.0.0.1:${(server.address() as { port: number }).port}`;

      const fetchPinnedTo = (serverCertificate: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() =>
            makePinnedAgent({
              address,
              serverCertificate,
              clientCertificate: client.certificate,
              clientKey: client.key,
            }),
          ),
          (agent) =>
            Effect.tryPromise(async () => {
              const response = await loadUndici().fetch(`https://${address}/1.0`, {
                dispatcher: agent,
              });
              return response.text();
            }),
          (agent) => Effect.promise(() => agent.close()),
        );

      assert.strictEqual(yield* fetchPinnedTo(served.certificate), "ok");
      const refused = yield* fetchPinnedTo(other.certificate).pipe(Effect.flip);
      assert.include(String((refused.cause as Error).cause), "different certificate");
    }).pipe(Effect.scoped),
  );
});
