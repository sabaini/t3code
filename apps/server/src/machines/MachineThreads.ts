import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

/** What machines need to know about the thread that owns them. */
export interface MachineThreadState {
  readonly projectId: ProjectId;
  readonly archived: boolean;
  readonly settled: boolean;
  /** A turn is preparing, queued, running or waiting. */
  readonly running: boolean;
  /** When the latest turn was requested or ended, in epoch milliseconds. */
  readonly lastTurnAt: number | null;
}

/** Thread events that can change whether its machines should run or exist. */
const LIFECYCLE_EVENTS = new Set([
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
]);

export class MachineThreadReadError extends Schema.TaggedError<MachineThreadReadError>()(
  "MachineThreadReadError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't read thread ${this.threadId}.`;
  }
}

export class MachineThreads extends Context.Service<
  MachineThreads,
  {
    /** None once the thread is deleted. */
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<MachineThreadState>, MachineThreadReadError>;
    /** Threads whose archived, deleted or settled state just changed. */
    readonly lifecycleChanges: Stream.Stream<ThreadId>;
  }
>()("t3/machines/MachineThreads") {}

const ThreadRow = Schema.Struct({
  project_id: ProjectId,
  archived_at: Schema.NullOr(Schema.String),
  deleted_at: Schema.NullOr(Schema.String),
  settled_at: Schema.NullOr(Schema.String),
  last_turn_at: Schema.NullOr(Schema.String),
  running: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;

  const get = Effect.fn("MachineThreads.get")(function* (threadId: ThreadId) {
    const rows = yield* sql`
      SELECT
        t.project_id,
        t.archived_at,
        t.deleted_at,
        json_extract(t.payload_json, '$.settledAt') AS settled_at,
        (
          SELECT MAX(COALESCE(r.completed_at, r.requested_at))
          FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
        ) AS last_turn_at,
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
        ) AS running
      FROM orchestration_v2_projection_threads t
      WHERE t.thread_id = ${threadId}
    `.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) => new MachineThreadReadError({ threadId, cause })),
      NodeSqliteClient.readOnly,
    );
    const row = rows[0];
    if (row === undefined || row.deleted_at !== null) return Option.none();
    const lastTurnAt = row.last_turn_at === null ? Number.NaN : Date.parse(row.last_turn_at);
    return Option.some({
      projectId: row.project_id,
      archived: row.archived_at !== null,
      settled: row.settled_at !== null,
      running: row.running !== 0,
      lastTurnAt: Number.isNaN(lastTurnAt) ? null : lastTurnAt,
    } satisfies MachineThreadState);
  });

  return MachineThreads.of({
    get,
    lifecycleChanges: engine.streamDomainEvents.pipe(
      Stream.filter((event) => LIFECYCLE_EVENTS.has(event.type)),
      Stream.map((event) => event.threadId),
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logWarning("Machines lost the thread event stream", { cause }),
        ).pipe(Stream.drain),
      ),
    ),
  });
});

export const layer = Layer.effect(MachineThreads, make);
