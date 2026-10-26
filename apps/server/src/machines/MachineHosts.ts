// @effect-diagnostics nodeBuiltinImport:off - Synchronous hashing for a stable host id; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";

import { type MachineHostConfig, ServerSettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as Settings from "../serverSettings.ts";
import { type LxdClient, type LxdError, makeLxdClient } from "./lxd/LxdClient.ts";
import { certificateFingerprint } from "./lxd/LxdTls.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  createLxdClientCredentials,
  joinLxdServer,
  type LxdCredentialsError,
  type LxdJoinError,
  type LxdTrustTokenError,
  parseLxdTrustToken,
} from "./lxd/LxdTrust.ts";
import { lxdVersionSupported, projectSandbox, type ProjectSandbox } from "./MachineSandbox.ts";

export class MachineHostNotFoundError extends Schema.TaggedError<MachineHostNotFoundError>()(
  "MachineHostNotFoundError",
  { hostId: Schema.String },
) {
  override get message(): string {
    return `There's no connected LXD server ${this.hostId}.`;
  }
}

export class MachineHostAlreadyConnectedError extends Schema.TaggedError<MachineHostAlreadyConnectedError>()(
  "MachineHostAlreadyConnectedError",
  { hostId: Schema.String, project: Schema.String },
) {
  override get message(): string {
    return `This LXD server's project ${this.project} is connected already.`;
  }
}

export type MachineHostConnectError =
  | LxdTrustTokenError
  | LxdCredentialsError
  | LxdJoinError
  | LxdError
  | MachineHostAlreadyConnectedError
  | ServerSettingsError;

export interface ConnectedMachineHost {
  readonly host: MachineHostConfig;
  readonly lxd: LxdClient;
}

export interface MachineHostStatus {
  readonly serverName: string;
  readonly version: string;
  readonly versionSupported: boolean;
  readonly instanceTypes: ReadonlyArray<string>;
  readonly sandbox: ProjectSandbox;
}

export class MachineHosts extends Context.Service<
  MachineHosts,
  {
    /** Joins the LXD server that issued `trustToken` and saves it in settings. */
    readonly connect: (input: {
      readonly trustToken: string;
      readonly label?: string | undefined;
    }) => Effect.Effect<MachineHostConfig, MachineHostConnectError>;
    /**
     * Forgets the server. Its trust in T3 Code's certificate is removed when it
     * answers; otherwise `manualCommand` says how to remove it there.
     */
    readonly disconnect: (
      hostId: string,
    ) => Effect.Effect<
      { readonly manualCommand: string | undefined },
      MachineHostNotFoundError | ServerSettingsError
    >;
    readonly status: (
      hostId: string,
    ) => Effect.Effect<
      MachineHostStatus,
      MachineHostNotFoundError | ServerSettingsError | LxdError
    >;
    readonly connected: Effect.Effect<ReadonlyArray<ConnectedMachineHost>, ServerSettingsError>;
  }
>()("t3/machines/MachineHosts") {}

/** Stable for a server and project, so leases find their host again after it reconnects. */
const machineHostId = (serverCertificate: string, project: string) =>
  `lxd-${NodeCrypto.createHash("sha256")
    .update(`${certificateFingerprint(serverCertificate)}\0${project}`)
    .digest("hex")
    .slice(0, 12)}`;

const connect = Effect.fn("MachineHosts.connect")(function* (input: {
  readonly trustToken: string;
  readonly label?: string | undefined;
}) {
  const settings = yield* Settings.ServerSettingsService;
  const token = yield* parseLxdTrustToken(input.trustToken);
  const credentials = yield* createLxdClientCredentials("t3-code");
  const joined = yield* joinLxdServer(token, credentials);
  const id = machineHostId(joined.serverCertificate, joined.project);
  const current = yield* settings.getSettings;
  if (current.machineHosts.some((host) => host.id === id)) {
    return yield* new MachineHostAlreadyConnectedError({ hostId: id, project: joined.project });
  }
  const host: MachineHostConfig = {
    id,
    label: input.label?.trim() || joined.serverName,
    address: joined.address,
    serverCertificate: joined.serverCertificate,
    project: joined.project,
    clientCertificate: credentials.certificate,
    clientKey: credentials.key,
  };
  yield* settings.updateSettings({ machineHosts: [...current.machineHosts, host] });
  return host;
});

const identityOf = (host: MachineHostConfig) => ({
  address: host.address,
  serverCertificate: host.serverCertificate,
  clientCertificate: host.clientCertificate,
  clientKey: host.clientKey,
});

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const context = yield* Effect.context<
    Settings.ServerSettingsService | ProcessRunner.ProcessRunner | FileSystem.FileSystem | Path.Path
  >();
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  // One client per host keeps its TLS connections alive between requests.
  const clients = new Map<
    string,
    { readonly key: string; readonly lxd: LxdClient; readonly scope: Scope.Closeable }
  >();

  const clientFor = Effect.fn("MachineHosts.clientFor")(function* (host: MachineHostConfig) {
    const key = [host.address, host.serverCertificate, host.clientCertificate, host.project].join(
      "\0",
    );
    const cached = clients.get(host.id);
    if (cached?.key === key) return cached.lxd;
    if (cached) yield* Scope.close(cached.scope, Exit.void);
    const scope = yield* Scope.fork(layerScope);
    const lxd = yield* makeLxdClient(identityOf(host), host.project).pipe(Scope.provide(scope));
    clients.set(host.id, { key, lxd, scope });
    return lxd;
  }, lock.withPermits(1));

  const findHost = Effect.fn("MachineHosts.findHost")(function* (hostId: string) {
    const host = (yield* settings.getSettings).machineHosts.find((entry) => entry.id === hostId);
    if (!host) return yield* new MachineHostNotFoundError({ hostId });
    return host;
  });

  const connected = Effect.gen(function* () {
    const hosts = (yield* settings.getSettings).machineHosts.filter(
      (host) => host.clientKey !== "",
    );
    return yield* Effect.forEach(hosts, (host) =>
      clientFor(host).pipe(Effect.map((lxd) => ({ host, lxd }))),
    );
  }).pipe(Effect.withSpan("MachineHosts.connected"));

  const disconnect = Effect.fn("MachineHosts.disconnect")(function* (hostId: string) {
    const host = yield* findHost(hostId);
    const removed = yield* clientFor(host).pipe(
      Effect.flatMap((lxd) => lxd.removeOwnCertificate),
      Effect.timeout("10 seconds"),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const current = yield* settings.getSettings;
    yield* settings.updateSettings({
      machineHosts: current.machineHosts.filter((entry) => entry.id !== hostId),
    });
    const cached = clients.get(hostId);
    clients.delete(hostId);
    if (cached) yield* Scope.close(cached.scope, Exit.void);
    return {
      manualCommand: removed
        ? undefined
        : `lxc config trust remove ${certificateFingerprint(host.clientCertificate).slice(0, 12)}`,
    };
  });

  const status = Effect.fn("MachineHosts.status")(function* (hostId: string) {
    const host = yield* findHost(hostId);
    const lxd = yield* clientFor(host);
    const server = yield* lxd.server;
    const config = yield* lxd.projectConfig(host.project);
    return {
      serverName: server.name,
      version: server.version,
      versionSupported: lxdVersionSupported(server.version),
      instanceTypes: server.instanceTypes,
      sandbox: projectSandbox(config),
    } satisfies MachineHostStatus;
  });

  return MachineHosts.of({
    connect: Effect.fn("MachineHosts.connectWithContext")((input) =>
      connect(input).pipe(Effect.provideContext(context)),
    ),
    disconnect,
    status,
    connected,
  });
});

export const layer = Layer.effect(MachineHosts, make);
