import { MachineProfile, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export const MachineLeaseStatus = Schema.Literals([
  "creating",
  "starting",
  "ready",
  "releasing",
  "failed",
]);
export type MachineLeaseStatus = typeof MachineLeaseStatus.Type;

export const MachineLease = Schema.Struct({
  leaseId: Schema.String,
  projectId: ProjectId,
  /** The thread whose agent acquired it. Any thread of the project may use or release it. */
  threadId: ThreadId,
  name: Schema.String,
  hostId: Schema.String,
  instance: Schema.String,
  network: Schema.String,
  /** What the machine was made from; later profile edits don't touch it. */
  profile: MachineProfile,
  storagePool: Schema.NullOr(Schema.String),
  /** Recorded before they exist, so releasing a half-made machine still finds its disks. */
  volumes: Schema.Array(Schema.String),
  status: MachineLeaseStatus,
  error: Schema.NullOr(Schema.String),
  /** `type base64` lines for the project's known_hosts. */
  hostKeys: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  /** Last SSH connection or machine tool call; idle machines are stopped. */
  lastUsedAt: Schema.Number,
});
export type MachineLease = typeof MachineLease.Type;

const LeaseRow = Schema.Struct({
  lease_id: Schema.String,
  thread_id: ThreadId,
  project_id: ProjectId,
  name: Schema.String,
  host_id: Schema.String,
  instance: Schema.String,
  network: Schema.String,
  profile_json: Schema.fromJsonString(MachineProfile),
  storage_pool: Schema.NullOr(Schema.String),
  volumes_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  status: MachineLeaseStatus,
  error: Schema.NullOr(Schema.String),
  host_keys_json: Schema.fromJsonString(Schema.Array(Schema.String)),
  created_at: Schema.Number,
  expires_at: Schema.Number,
  last_used_at: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(LeaseRow));
const leaseOf = (row: typeof LeaseRow.Type): MachineLease => ({
  leaseId: row.lease_id,
  threadId: row.thread_id,
  projectId: row.project_id,
  name: row.name,
  hostId: row.host_id,
  instance: row.instance,
  network: row.network,
  profile: row.profile_json,
  storagePool: row.storage_pool,
  volumes: row.volumes_json,
  status: row.status,
  error: row.error,
  hostKeys: row.host_keys_json,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeProfile = Schema.encodeSync(MachineProfile);

export class MachineLeaseStoreError extends Schema.TaggedError<MachineLeaseStoreError>()(
  "MachineLeaseStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Machine lease storage failed to ${this.operation}.`;
  }
}

export class MachineLeaseStore extends Context.Service<
  MachineLeaseStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<MachineLease>, MachineLeaseStoreError>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<MachineLease>, MachineLeaseStoreError>;
    /** Inserts or replaces the lease by id. */
    readonly save: (lease: MachineLease) => Effect.Effect<void, MachineLeaseStoreError>;
    readonly remove: (leaseId: string) => Effect.Effect<void, MachineLeaseStoreError>;
    readonly touch: (leaseId: string, at: number) => Effect.Effect<void, MachineLeaseStoreError>;
  }
>()("@t3tools/machines/MachineLeaseStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Not a numbered migration: this fork's ids would collide with upstream's next
  // one, and the migrator skips ids at or below the latest applied.
  // Leases from when threads owned machines are dropped; their instances show as untracked.
  yield* sql`DROP TABLE IF EXISTS machine_leases`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS machine_project_leases (
      lease_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      host_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      network TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      storage_pool TEXT,
      volumes_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      host_keys_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      UNIQUE (project_id, name)
    )
  `;

  const failed = (operation: string) => (cause: unknown) =>
    new MachineLeaseStoreError({ operation, cause });

  const select = (
    query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
    operation: string,
  ) =>
    query.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map(leaseOf)),
      Effect.mapError(failed(operation)),
    );

  return MachineLeaseStore.of({
    list: select(sql`SELECT * FROM machine_project_leases ORDER BY created_at`, "list leases"),
    listForProject: Effect.fn("MachineLeaseStore.listForProject")((projectId: ProjectId) =>
      select(
        sql`SELECT * FROM machine_project_leases WHERE project_id = ${projectId} ORDER BY created_at`,
        "list a project's leases",
      ),
    ),
    save: Effect.fn("MachineLeaseStore.save")((lease: MachineLease) =>
      sql`
        INSERT INTO machine_project_leases (
          lease_id, thread_id, project_id, name, host_id, instance, network, profile_json,
          storage_pool, volumes_json, status, error, host_keys_json, created_at, expires_at,
          last_used_at
        ) VALUES (
          ${lease.leaseId}, ${lease.threadId}, ${lease.projectId}, ${lease.name}, ${lease.hostId},
          ${lease.instance}, ${lease.network}, ${encodeJson(encodeProfile(lease.profile))},
          ${lease.storagePool}, ${encodeJson(lease.volumes)}, ${lease.status}, ${lease.error},
          ${encodeJson(lease.hostKeys)}, ${lease.createdAt}, ${lease.expiresAt}, ${lease.lastUsedAt}
        )
        ON CONFLICT (lease_id) DO UPDATE SET
          storage_pool = excluded.storage_pool,
          volumes_json = excluded.volumes_json,
          status = excluded.status,
          error = excluded.error,
          host_keys_json = excluded.host_keys_json,
          expires_at = excluded.expires_at,
          last_used_at = excluded.last_used_at
      `.pipe(Effect.asVoid, Effect.mapError(failed("save a lease"))),
    ),
    remove: Effect.fn("MachineLeaseStore.remove")((leaseId: string) =>
      sql`DELETE FROM machine_project_leases WHERE lease_id = ${leaseId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failed("remove a lease")),
      ),
    ),
    touch: Effect.fn("MachineLeaseStore.touch")((leaseId: string, at: number) =>
      sql`
        UPDATE machine_project_leases SET last_used_at = MAX(last_used_at, ${at})
        WHERE lease_id = ${leaseId}
      `.pipe(Effect.asVoid, Effect.mapError(failed("record machine use"))),
    ),
  });
});

export const layer = Layer.effect(MachineLeaseStore, make);
