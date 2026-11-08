import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Undici from "undici";

import {
  certificateFingerprint,
  loadUndici,
  type LxdIdentity,
  LxdUnreachableError,
  makePinnedAgent,
} from "./LxdTls.ts";

/** LXD answered with an error, for the request or the operation it started. */
export class LxdRequestError extends Schema.TaggedError<LxdRequestError>()("LxdRequestError", {
  operation: Schema.String,
  status: Schema.Number,
  /** LXD's own explanation, which agents and users need to act on. Capped. */
  reason: Schema.String,
}) {
  override get message(): string {
    return `LXD refused ${this.operation}: ${this.reason}`;
  }
}

export class LxdResponseError extends Schema.TaggedError<LxdResponseError>()("LxdResponseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Unexpected LXD response to ${this.operation}.`;
  }
}

export type LxdError = LxdRequestError | LxdResponseError | LxdUnreachableError;

const StringRecord = Schema.Record(Schema.String, Schema.String);
const Devices = Schema.Record(Schema.String, StringRecord);

const Envelope = Schema.Struct({
  type: Schema.String,
  error: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
  operation: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
});
type Envelope = typeof Envelope.Type;

const OperationResult = Schema.Struct({
  status_code: Schema.Number,
  err: Schema.String,
  metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

const ServerInfo = Schema.Struct({
  environment: Schema.Struct({
    server_name: Schema.String,
    server_version: Schema.String,
    // LXD before 4.21 doesn't say, and is too old for machines anyway.
    instance_types: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
});
const Certificate = Schema.Struct({
  restricted: Schema.Boolean,
  projects: Schema.Array(Schema.String),
});
const Project = Schema.Struct({ config: StringRecord });

export const LxdInstance = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  status: Schema.String,
  config: StringRecord,
  /** The instance's own devices, without those its profiles add. */
  devices: Devices,
});
export type LxdInstance = typeof LxdInstance.Type;

const InstanceState = Schema.Struct({
  state: Schema.NullOr(
    Schema.Struct({
      network: Schema.NullOr(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            /** The device's host side; empty for interfaces the instance made itself, like docker0. */
            host_name: Schema.String,
            addresses: Schema.NullOr(
              Schema.Array(
                Schema.Struct({
                  family: Schema.String,
                  address: Schema.String,
                  scope: Schema.String,
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
});

const Profile = Schema.Struct({ devices: Devices });
const Network = Schema.Struct({
  config: StringRecord,
  used_by: Schema.NullOr(Schema.Array(Schema.String)),
});
export interface LxdNetwork {
  readonly config: Readonly<Record<string, string>>;
  readonly usedBy: ReadonlyArray<string>;
}

const AclRule = Schema.Record(Schema.String, Schema.String);
const NetworkAcl = Schema.Struct({ egress: Schema.Array(AclRule), ingress: Schema.Array(AclRule) });
export type LxdNetworkAcl = typeof NetworkAcl.Type;

/** A network ACL rule as machines write it. LXD leaves empty fields out of its answers too. */
export interface LxdNetworkAclRule {
  readonly action: "allow" | "reject" | "drop";
  readonly source?: string;
  readonly destination?: string;
  readonly state: "enabled";
}
export interface LxdNetworkAclPut {
  readonly description: string;
  readonly egress: ReadonlyArray<LxdNetworkAclRule>;
  readonly ingress: ReadonlyArray<LxdNetworkAclRule>;
}

export interface LxdInstancesPost {
  readonly name: string;
  readonly description?: string;
  readonly type: "container" | "virtual-machine";
  readonly source: {
    readonly type: "image";
    readonly alias: string;
    readonly server?: string;
    readonly protocol?: "simplestreams" | "lxd";
  };
  readonly profiles?: ReadonlyArray<string>;
  readonly config?: Readonly<Record<string, string>>;
  readonly devices?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly start?: boolean;
}

const ExecStarted = Schema.Struct({
  fds: Schema.Struct({
    "0": Schema.String,
    "1": Schema.String,
    "2": Schema.String,
    control: Schema.String,
  }),
});
// A failed exec reports no exit status.
const ExecFinished = Schema.NullOr(Schema.Struct({ return: Schema.optional(Schema.Number) }));

/** A command running in an instance, without a terminal. */
export interface LxdExec {
  /** Resolves once LXD has taken the bytes, so a slow command holds back its input. */
  readonly write: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly closeStdin: Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  /** Waits for the command to end. */
  readonly exitCode: Effect.Effect<number, LxdError>;
}

export interface LxdServerInfo {
  readonly name: string;
  readonly version: string;
  /** Kinds of instance it can run now: no virtual machines without /dev/kvm. */
  readonly instanceTypes: ReadonlyArray<string>;
}

export interface LxdClient {
  readonly address: string;
  /** The pinned server certificate's fingerprint: the server keeps it when its address changes. */
  readonly fingerprint: string;
  readonly server: Effect.Effect<LxdServerInfo, LxdError>;
  /** Redeem a trust token for the client certificate this client presents. */
  readonly addCertificate: (trustToken: string) => Effect.Effect<void, LxdError>;
  readonly ownCertificate: Effect.Effect<typeof Certificate.Type, LxdError>;
  /** Restricted certificates may remove themselves. */
  readonly removeOwnCertificate: Effect.Effect<void, LxdError>;
  readonly projectConfig: (project: string) => Effect.Effect<Record<string, string>, LxdError>;
  readonly instances: Effect.Effect<ReadonlyArray<LxdInstance>, LxdError>;
  readonly instance: (name: string) => Effect.Effect<Option.Option<LxdInstance>, LxdError>;
  /** Global addresses on its LXD network devices while it runs, IPv4 first. */
  readonly instanceAddresses: (name: string) => Effect.Effect<ReadonlyArray<string>, LxdError>;
  readonly profileDevices: (
    profile: string,
  ) => Effect.Effect<
    Option.Option<Readonly<Record<string, Readonly<Record<string, string>>>>>,
    LxdError
  >;
  readonly network: (name: string) => Effect.Effect<Option.Option<LxdNetwork>, LxdError>;
  readonly createNetwork: (post: {
    readonly name: string;
    readonly description: string;
    readonly config: Readonly<Record<string, string>>;
  }) => Effect.Effect<void, LxdError>;
  /** Sets these settings, leaving the network's others as they are. */
  readonly updateNetwork: (
    name: string,
    config: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, LxdError>;
  /** A network that's gone already is fine. LXD refuses while an instance uses it. */
  readonly deleteNetwork: (name: string) => Effect.Effect<void, LxdError>;
  readonly networkAcl: (name: string) => Effect.Effect<Option.Option<LxdNetworkAcl>, LxdError>;
  readonly createNetworkAcl: (name: string, put: LxdNetworkAclPut) => Effect.Effect<void, LxdError>;
  /** Replaces the ACL's rules; every network using it follows. */
  readonly updateNetworkAcl: (name: string, put: LxdNetworkAclPut) => Effect.Effect<void, LxdError>;
  readonly createInstance: (post: LxdInstancesPost) => Effect.Effect<void, LxdError>;
  readonly setInstanceState: (
    name: string,
    action: "start" | "stop",
    force?: boolean,
  ) => Effect.Effect<void, LxdError>;
  /** An instance that's gone already is fine. LXD refuses to delete a running one. */
  readonly deleteInstance: (name: string) => Effect.Effect<void, LxdError>;
  /** None when the file doesn't exist (yet). A VM's files come through its LXD agent, which may not run yet. */
  readonly readInstanceFile: (
    name: string,
    path: string,
  ) => Effect.Effect<Option.Option<Uint8Array>, LxdError>;
  readonly createBlockVolume: (
    pool: string,
    volume: string,
    sizeGiB: number,
  ) => Effect.Effect<void, LxdError>;
  /** A volume that's gone already is fine. */
  readonly deleteVolume: (pool: string, volume: string) => Effect.Effect<void, LxdError>;
  /** The command ends when the scope closes: LXD kills it once its control stream does. */
  readonly exec: (
    name: string,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<LxdExec, LxdError, Scope.Scope>;
}

const REASON_MAX_CHARS = 500;
/** Seconds each operation wait may hold a request open; waits for longer operations repeat it. */
const OPERATION_WAIT_SECONDS = 30;
/** Input waits above this many unsent bytes, so a large upload can't pile up in memory. */
const STDIN_HIGH_WATER_BYTES = 1024 * 1024;

const segment = (value: string) => encodeURIComponent(value);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isMissing = (error: LxdError) => error._tag === "LxdRequestError" && error.status === 404;
const missingAsNone = <A>(effect: Effect.Effect<A, LxdError>) =>
  effect.pipe(
    Effect.asSome,
    Effect.catchIf(isMissing, () => Effect.succeed(Option.none<A>())),
  );
const isWaitDeadline = (error: LxdError) =>
  error._tag === "LxdRequestError" && error.reason === "context deadline exceeded";
const missingAsDone = (effect: Effect.Effect<void, LxdError>) =>
  effect.pipe(Effect.catchIf(isMissing, () => Effect.void));

/**
 * One LXD server reached with a pinned client identity. Without `project`,
 * only server-wide requests make sense, as while joining.
 */
export const makeLxdClient = Effect.fn("LxdClient.make")(function* (
  identity: LxdIdentity,
  project: string | undefined,
) {
  const undici = loadUndici();
  const agent = yield* Effect.acquireRelease(
    Effect.sync(() => makePinnedAgent(identity)),
    (agent) => Effect.promise(() => agent.close()).pipe(Effect.ignore),
  );
  const { address } = identity;

  const url = (path: string, query: Readonly<Record<string, string>> = {}, scheme = "https") => {
    const target = new URL(path, `${scheme}://${address}`);
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    if (project !== undefined) target.searchParams.set("project", project);
    return target;
  };

  // Each request is traced by its caller's span; tracing them all would double the spans.
  const send = Effect.fnUntraced(function* (
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly query?: Readonly<Record<string, string>> } = {},
  ) {
    return yield* Effect.tryPromise({
      try: (signal) =>
        undici.fetch(url(path, options.query), {
          method,
          dispatcher: agent,
          signal,
          ...(options.body === undefined
            ? {}
            : {
                body: encodeJson(options.body),
                headers: { "content-type": "application/json" },
              }),
        }),
      catch: (cause) => new LxdUnreachableError({ address, cause }),
    });
  });

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
    operation: string,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new LxdResponseError({ operation, cause })),
    );

  const refused = (operation: string, status: number, reason: string) =>
    new LxdRequestError({ operation, status, reason: reason.slice(0, REASON_MAX_CHARS) });

  const envelope = Effect.fnUntraced(function* (
    response: Awaited<ReturnType<typeof undici.fetch>>,
    operation: string,
  ) {
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new LxdResponseError({ operation, cause }),
    });
    const decoded = yield* decode(Envelope, json, operation);
    if (decoded.type === "error") {
      return yield* refused(operation, decoded.error_code ?? response.status, decoded.error ?? "");
    }
    return decoded;
  });

  const request = Effect.fnUntraced(function* (
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly query?: Readonly<Record<string, string>> } = {},
  ) {
    return yield* envelope(yield* send(method, path, options), `${method} ${path}`);
  });

  const get = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    path: string,
    query?: Readonly<Record<string, string>>,
  ) =>
    request("GET", path, query === undefined ? {} : { query }).pipe(
      Effect.flatMap((response) => decode(schema, response.metadata, `GET ${path}`)),
    );

  const waitFor = Effect.fnUntraced(function* (operationPath: string, operation: string) {
    while (true) {
      const response = yield* request("GET", `${operationPath}/wait`, {
        query: { timeout: String(OPERATION_WAIT_SECONDS) },
      }).pipe(Effect.catchIf(isWaitDeadline, () => Effect.void));
      // LXD answers a wait that outlives its timeout with this error, not the running operation.
      if (response === undefined) continue;
      const result = yield* decode(OperationResult, response.metadata, operation);
      // Below 200 the operation is still pending or running.
      if (result.status_code < 200) continue;
      if (result.status_code !== 200) {
        return yield* refused(operation, result.status_code, result.err || "operation failed");
      }
      return result;
    }
  });

  /** Make a change, waiting for its operation when LXD runs it in the background. */
  const perform = Effect.fnUntraced(function* (method: string, path: string, body?: unknown) {
    const response: Envelope = yield* request(method, path, body === undefined ? {} : { body });
    if (response.type === "async" && response.operation !== undefined) {
      yield* waitFor(response.operation, `${method} ${path}`);
    }
  });

  const ownCertificatePath = `/1.0/certificates/${certificateFingerprint(identity.clientCertificate)}`;

  const exec = Effect.fn("LxdClient.exec")(function* (
    name: string,
    command: ReadonlyArray<string>,
  ) {
    const path = `/1.0/instances/${segment(name)}/exec`;
    const operation = `POST ${path}`;
    const started = yield* request("POST", path, {
      body: {
        command,
        environment: {},
        interactive: false,
        "wait-for-websocket": true,
        "record-output": false,
      },
    });
    if (started.operation === undefined) {
      return yield* new LxdResponseError({ operation, cause: new Error("No operation") });
    }
    const operationPath = started.operation;
    const { fds } = yield* decode(
      Schema.Struct({ metadata: ExecStarted }),
      started.metadata,
      operation,
    ).pipe(Effect.map((metadata) => metadata.metadata));

    const open = (secret: string) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          // The command can write before this side has seen every stream open, so output is
          // queued from the moment each socket exists.
          const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          const socket = yield* Effect.callback<Undici.WebSocket, LxdUnreachableError>((resume) => {
            const socket = new undici.WebSocket(
              url(`${operationPath}/websocket`, { secret }, "wss").toString(),
              { dispatcher: agent },
            );
            socket.binaryType = "arraybuffer";
            socket.addEventListener("message", (message) => {
              Queue.offerUnsafe(queue, new Uint8Array(message.data as ArrayBuffer));
            });
            socket.addEventListener("close", () => Queue.endUnsafe(queue), { once: true });
            socket.addEventListener("open", () => resume(Effect.succeed(socket)), {
              once: true,
            });
            socket.addEventListener(
              "error",
              () =>
                resume(
                  Effect.fail(
                    new LxdUnreachableError({ address, cause: new Error("Exec stream refused") }),
                  ),
                ),
              { once: true },
            );
            return Effect.sync(() => socket.close());
          });
          return { socket, output: Stream.fromQueue(queue) };
        }),
        ({ socket }) => Effect.sync(() => socket.close()),
      );

    // LXD starts the command only once every stream is connected.
    const [, { socket: stdin }, { output: stdout }, { output: stderr }] = yield* Effect.all(
      [open(fds.control), open(fds["0"]), open(fds["1"]), open(fds["2"])],
      { concurrency: "unbounded" },
    );

    const write = Effect.fnUntraced(function* (chunk: Uint8Array) {
      // undici's WebSocket has no drain event, so a full buffer is polled until it empties.
      while (
        stdin.readyState === undici.WebSocket.OPEN &&
        stdin.bufferedAmount > STDIN_HIGH_WATER_BYTES
      ) {
        yield* Effect.sleep("10 millis");
      }
      if (stdin.readyState === undici.WebSocket.OPEN) stdin.send(chunk);
    });

    const exitCode = waitFor(operationPath, operation).pipe(
      Effect.flatMap((result) => decode(ExecFinished, result.metadata ?? null, operation)),
      Effect.flatMap((finished) =>
        finished?.return === undefined
          ? Effect.fail(new LxdResponseError({ operation, cause: new Error("No exit status") }))
          : Effect.succeed(finished.return),
      ),
    );

    return {
      write,
      // Closing the input stream is end of input for a command without a terminal.
      closeStdin: Effect.sync(() => stdin.close()),
      stdout,
      stderr,
      exitCode,
    } satisfies LxdExec;
  });

  return {
    address,
    fingerprint: certificateFingerprint(identity.serverCertificate),
    server: get(ServerInfo, "/1.0").pipe(
      Effect.map(({ environment }) => ({
        name: environment.server_name,
        version: environment.server_version,
        instanceTypes: environment.instance_types ?? [],
      })),
      Effect.withSpan("LxdClient.server"),
    ),
    addCertificate: (trustToken) =>
      perform("POST", "/1.0/certificates", { type: "client", trust_token: trustToken }).pipe(
        Effect.withSpan("LxdClient.addCertificate"),
      ),
    ownCertificate: get(Certificate, ownCertificatePath).pipe(
      Effect.withSpan("LxdClient.ownCertificate"),
    ),
    removeOwnCertificate: perform("DELETE", ownCertificatePath).pipe(
      Effect.withSpan("LxdClient.removeOwnCertificate"),
    ),
    projectConfig: (name) =>
      get(Project, `/1.0/projects/${segment(name)}`).pipe(
        Effect.map((value) => ({ ...value.config })),
        Effect.withSpan("LxdClient.projectConfig"),
      ),
    instances: get(Schema.Array(LxdInstance), "/1.0/instances", { recursion: "1" }).pipe(
      Effect.withSpan("LxdClient.instances"),
    ),
    instance: (name) =>
      missingAsNone(get(LxdInstance, `/1.0/instances/${segment(name)}`)).pipe(
        Effect.withSpan("LxdClient.instance"),
      ),
    instanceAddresses: (name) =>
      get(InstanceState, `/1.0/instances/${segment(name)}`, { recursion: "1" }).pipe(
        Effect.map(({ state }) =>
          Object.values(state?.network ?? {})
            .filter((device) => device.host_name !== "")
            .flatMap((device) => (device.addresses ?? []).filter((a) => a.scope === "global"))
            .sort((a, b) => Number(a.family !== "inet") - Number(b.family !== "inet"))
            .map((a) => a.address),
        ),
        Effect.withSpan("LxdClient.instanceAddresses"),
      ),
    profileDevices: (profile) =>
      missingAsNone(get(Profile, `/1.0/profiles/${segment(profile)}`)).pipe(
        Effect.map(Option.map((value) => value.devices)),
        Effect.withSpan("LxdClient.profileDevices"),
      ),
    network: (name) =>
      missingAsNone(get(Network, `/1.0/networks/${segment(name)}`)).pipe(
        Effect.map(Option.map((value) => ({ config: value.config, usedBy: value.used_by ?? [] }))),
        Effect.withSpan("LxdClient.network"),
      ),
    createNetwork: (post) =>
      perform("POST", "/1.0/networks", { ...post, type: "ovn" }).pipe(
        Effect.withSpan("LxdClient.createNetwork"),
      ),
    updateNetwork: (name, config) =>
      perform("PATCH", `/1.0/networks/${segment(name)}`, { config }).pipe(
        Effect.withSpan("LxdClient.updateNetwork"),
      ),
    deleteNetwork: (name) =>
      missingAsDone(perform("DELETE", `/1.0/networks/${segment(name)}`)).pipe(
        Effect.withSpan("LxdClient.deleteNetwork"),
      ),
    networkAcl: (name) =>
      missingAsNone(get(NetworkAcl, `/1.0/network-acls/${segment(name)}`)).pipe(
        Effect.withSpan("LxdClient.networkAcl"),
      ),
    createNetworkAcl: (name, put) =>
      perform("POST", "/1.0/network-acls", { name, ...put }).pipe(
        Effect.withSpan("LxdClient.createNetworkAcl"),
      ),
    updateNetworkAcl: (name, put) =>
      perform("PUT", `/1.0/network-acls/${segment(name)}`, put).pipe(
        Effect.withSpan("LxdClient.updateNetworkAcl"),
      ),
    createInstance: (post) =>
      perform("POST", "/1.0/instances", post).pipe(Effect.withSpan("LxdClient.createInstance")),
    setInstanceState: (name, action, force = false) =>
      // Without `force`, stopping gives the instance 30 seconds to shut down cleanly.
      perform("PUT", `/1.0/instances/${segment(name)}/state`, { action, force, timeout: 30 }).pipe(
        Effect.withSpan("LxdClient.setInstanceState"),
      ),
    deleteInstance: (name) =>
      missingAsDone(perform("DELETE", `/1.0/instances/${segment(name)}`)).pipe(
        Effect.withSpan("LxdClient.deleteInstance"),
      ),
    readInstanceFile: Effect.fn("LxdClient.readInstanceFile")(function* (name, path) {
      const filesPath = `/1.0/instances/${segment(name)}/files`;
      const operation = `GET ${filesPath}`;
      const response = yield* send("GET", filesPath, { query: { path } });
      if (response.status === 404) {
        yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
        return Option.none<Uint8Array>();
      }
      if (!response.ok) return yield* envelope(response, operation).pipe(Effect.as(Option.none()));
      const bytes = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: (cause) => new LxdResponseError({ operation, cause }),
      });
      return Option.some(new Uint8Array(bytes));
    }),
    createBlockVolume: (pool, volume, sizeGiB) =>
      perform("POST", `/1.0/storage-pools/${segment(pool)}/volumes/custom`, {
        name: volume,
        content_type: "block",
        config: { size: `${sizeGiB}GiB` },
      }).pipe(Effect.withSpan("LxdClient.createBlockVolume")),
    deleteVolume: (pool, volume) =>
      missingAsDone(
        perform("DELETE", `/1.0/storage-pools/${segment(pool)}/volumes/custom/${segment(volume)}`),
      ).pipe(Effect.withSpan("LxdClient.deleteVolume")),
    exec,
  } satisfies LxdClient;
});
