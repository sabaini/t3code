import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import { makeLxdClient } from "./LxdClient.ts";
import { certificateFingerprint, probeServerCertificate } from "./LxdTls.ts";

export class LxdTrustTokenError extends Schema.TaggedError<LxdTrustTokenError>()(
  "LxdTrustTokenError",
  { reason: Schema.Literals(["invalid", "expired", "not-listening"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid":
        return "That doesn't look like an LXD trust token. Paste the whole last line that `lxc config trust add` printed.";
      case "expired":
        return "This LXD trust token has expired. Create a new one.";
      case "not-listening":
        return "This LXD server isn't listening on the network yet. Run `lxc config set core.https_address :8443` on it, then create a new token.";
    }
  }
}

export class LxdJoinError extends Schema.TaggedError<LxdJoinError>()("LxdJoinError", {
  reason: Schema.Literals(["unreachable", "rejected", "name-taken", "not-restricted"]),
  clientName: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unreachable":
        return "Couldn't reach the LXD server that issued this token at any of its addresses.";
      case "rejected":
        return "LXD didn't accept this token. Each token works only once, so create a new one.";
      case "name-taken":
        return `This LXD server already trusts a certificate called ${this.clientName}. If it isn't connected here, run \`lxc config trust remove\` on the server for it, then create a new token.`;
      case "not-restricted":
        return "This token isn't limited to a single project. Create one with `--restricted --projects <project>`, so T3 Code can only use that project.";
    }
  }
}

export class LxdCredentialsError extends Schema.TaggedError<LxdCredentialsError>()(
  "LxdCredentialsError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "openssl couldn't create an LXD client certificate.";
  }
}

const TrustTokenJson = Schema.fromJsonString(
  Schema.Struct({
    client_name: Schema.String,
    fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    addresses: Schema.NullOr(Schema.Array(Schema.String)),
    secret: Schema.String.check(Schema.isNonEmpty()),
    expires_at: Schema.String,
  }),
);
const decodeTrustToken = Schema.decodeUnknownEffect(TrustTokenJson);

export interface LxdTrustToken {
  /** The token exactly as issued; LXD wants all of it back, not just its secret. */
  readonly token: string;
  readonly clientName: string;
  readonly fingerprint: string;
  readonly addresses: ReadonlyArray<string>;
}

export const parseLxdTrustToken = Effect.fn("LxdTrust.parseToken")(function* (input: string) {
  const token = input.trim();
  const invalid = new LxdTrustTokenError({ reason: "invalid" });
  const decoded = yield* decodeTrustToken(Buffer.from(token, "base64").toString("utf8")).pipe(
    Effect.mapError(() => invalid),
  );
  const expiresAt = DateTime.make(decoded.expires_at);
  if (expiresAt._tag === "None") return yield* invalid;
  // LXD writes the zero time for tokens that never expire.
  if (DateTime.toEpochMillis(expiresAt.value) > 0) {
    const now = yield* DateTime.now;
    if (DateTime.isLessThanOrEqualTo(expiresAt.value, now)) {
      return yield* new LxdTrustTokenError({ reason: "expired" });
    }
  }
  const addresses = decoded.addresses ?? [];
  if (addresses.length === 0) return yield* new LxdTrustTokenError({ reason: "not-listening" });
  return {
    token,
    clientName: decoded.client_name,
    fingerprint: decoded.fingerprint,
    addresses,
  } satisfies LxdTrustToken;
});

/** A new key pair and self-signed client certificate, like the one `lxc` makes for itself. */
export const createLxdClientCredentials = Effect.fn("LxdTrust.createClientCredentials")(function* (
  commonName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-lxd-" })
    .pipe(Effect.mapError((cause) => new LxdCredentialsError({ cause })));
  const certificatePath = path.join(directory, "client.crt");
  const keyPath = path.join(directory, "client.key");
  const result = yield* runner
    .run({
      command: "openssl",
      args: [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:secp384r1",
        "-sha384",
        "-nodes",
        "-days",
        "3650",
        "-subj",
        `/CN=${commonName}`,
        "-addext",
        "extendedKeyUsage=clientAuth",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
      ],
    })
    .pipe(Effect.mapError((cause) => new LxdCredentialsError({ cause })));
  if (result.code !== 0) {
    return yield* new LxdCredentialsError({ cause: new Error(result.stderr.slice(0, 500)) });
  }
  const [certificate, key] = yield* Effect.all([
    fs.readFileString(certificatePath),
    fs.readFileString(keyPath),
  ]).pipe(Effect.mapError((cause) => new LxdCredentialsError({ cause })));
  return { certificate, key };
}, Effect.scoped);

/**
 * Trusts `credentials` on the server that issued `token`. The token lists every
 * address of that server; the first one presenting the certificate the token
 * names is pinned. Only tokens restricted to a single project are accepted.
 */
export const joinLxdServer = Effect.fn("LxdTrust.join")(function* (
  token: LxdTrustToken,
  credentials: { certificate: string; key: string },
) {
  const probes = yield* Effect.forEach(
    token.addresses,
    (address) =>
      probeServerCertificate(address).pipe(
        Effect.map((certificate) => ({ address, certificate })),
        Effect.result,
      ),
    { concurrency: "unbounded" },
  );
  const reached = probes
    .filter(Result.isSuccess)
    .map((probe) => probe.success)
    .find((probe) => certificateFingerprint(probe.certificate) === token.fingerprint);
  if (!reached) {
    return yield* new LxdJoinError({ reason: "unreachable", clientName: token.clientName });
  }
  const identity = {
    address: reached.address,
    serverCertificate: reached.certificate,
    clientCertificate: credentials.certificate,
    clientKey: credentials.key,
  };
  const lxd = yield* makeLxdClient(identity, undefined);
  yield* lxd.addCertificate(token.token).pipe(
    Effect.catchTags({
      LxdRequestError: (error) =>
        // LXD answers every unusable token the same way; tokens work once.
        error.status === 403
          ? Effect.fail(
              new LxdJoinError({ reason: "rejected", clientName: token.clientName, cause: error }),
            )
          : error.status === 409
            ? Effect.fail(
                new LxdJoinError({
                  reason: "name-taken",
                  clientName: token.clientName,
                  cause: error,
                }),
              )
            : Effect.fail(error),
    }),
  );
  const own = yield* lxd.ownCertificate;
  if (!own.restricted || own.projects.length !== 1) {
    yield* lxd.removeOwnCertificate.pipe(Effect.ignore);
    return yield* new LxdJoinError({ reason: "not-restricted", clientName: token.clientName });
  }
  const server = yield* lxd.server;
  return {
    address: reached.address,
    serverCertificate: reached.certificate,
    project: own.projects[0]!,
    serverName: server.name,
  };
}, Effect.scoped);
