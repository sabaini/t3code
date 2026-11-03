// @effect-diagnostics nodeBuiltinImport:off - X.509 parsing and raw TLS sockets have no Effect API.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeTls from "node:tls";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Undici from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
const requireUndici = NodeModule.createRequire(import.meta.url);
export const loadUndici = () => requireUndici("undici") as typeof Undici;

/** An LXD API endpoint, the server certificate pinned for it, and the client certificate it trusts. */
export interface LxdIdentity {
  readonly address: string;
  readonly serverCertificate: string;
  readonly clientCertificate: string;
  readonly clientKey: string;
}

export class LxdUnreachableError extends Schema.TaggedError<LxdUnreachableError>()(
  "LxdUnreachableError",
  { address: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't reach the LXD server at ${this.address}.`;
  }
}

/** SHA-256 of the DER certificate, as LXD names certificates and trust tokens name servers. */
export const certificateFingerprint = (certificate: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256")
    .update(new NodeCrypto.X509Certificate(certificate).raw)
    .digest("hex");

/** Not through URL, which drops 443 as the default port of https. */
function parseLxdAddress(
  address: string,
): { readonly host: string; readonly port: number } | undefined {
  const parts = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/.exec(address);
  if (!parts) return undefined;
  const port = Number(parts[3] ?? 8443);
  if (port < 1 || port > 65_535) return undefined;
  return { host: parts[1] ?? parts[2]!, port };
}

/**
 * The certificate the server at `address` presents, unverified. Only joining
 * uses it, to find the address whose certificate the trust token names.
 */
export const probeServerCertificate = Effect.fn("LxdTls.probeServerCertificate")(function* (
  address: string,
) {
  const endpoint = parseLxdAddress(address);
  if (!endpoint) {
    return yield* new LxdUnreachableError({ address, cause: new Error("Not a host:port address") });
  }
  return yield* Effect.callback<string, LxdUnreachableError>((resume) => {
    const socket = NodeTls.connect({ ...endpoint, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      resume(Effect.succeed(new NodeCrypto.X509Certificate(peer.raw).toString()));
    });
    socket.once("error", (cause) =>
      resume(Effect.fail(new LxdUnreachableError({ address, cause }))),
    );
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(new LxdUnreachableError({ address, cause: new Error("Timed out connecting") })),
    }),
  );
});

/**
 * LXD certs are self-signed `CA:FALSE` leaves, which BoringSSL (Electron) refuses as their own
 * trust anchor, so every connection is checked against the pinned fingerprint instead of a CA.
 * HTTP/1.1 only: LXD's exec websockets can't run over HTTP/2, and undici 8's HTTP/2 sessions emit
 * unhandled stream errors on the idle timeouts of LXD's operation waits (see outboundHttp.ts).
 */
export function makePinnedAgent(identity: LxdIdentity): Undici.Agent {
  const pinned = certificateFingerprint(identity.serverCertificate);
  const undici = loadUndici();
  const connectTls = undici.buildConnector({
    cert: identity.clientCertificate,
    key: identity.clientKey,
    rejectUnauthorized: false,
    // A resumed session skips the handshake that the fingerprint check below relies on.
    maxCachedSessions: 0,
    // The Agent's own `allowH2` doesn't reach a custom connector, which would offer h2 in ALPN.
    allowH2: false,
  });
  return new undici.Agent({
    allowH2: false,
    // Operation waits are bounded by their own `timeout` query, well below this.
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
    connect: (options, callback) =>
      connectTls(options, (error, socket) => {
        if (error) return callback(error, null);
        const peer = socket instanceof NodeTls.TLSSocket ? socket.getPeerCertificate() : undefined;
        if (peer?.raw && certificateFingerprint(peer.raw) === pinned) return callback(null, socket);
        socket.destroy();
        callback(
          new Error("The LXD server presented a different certificate than the one pinned."),
          null,
        );
      }),
  });
}
