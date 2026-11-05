import { ProjectId } from "@t3tools/contracts";
import { MachinePlatform, MachinePlatformError } from "@t3tools/machines/MachinePlatform";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";

const ProjectRow = Schema.Struct({ deleted_at: Schema.NullOr(Schema.String) });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProjectRow));

/** Machines on T3 Code's server: settings, the secret store, and the server's projects. */
export const layer = Layer.effect(
  MachinePlatform,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.ProcessRunner;
    const sql = yield* SqlClient.SqlClient;
    const hosts = settings.getSettings.pipe(Effect.map((current) => current.machineHosts));

    return MachinePlatform.of({
      environmentId: environment.getEnvironmentId,
      stateDir: config.stateDir,
      hosts,
      setHosts: Effect.fn("ServerMachinePlatform.setHosts")(function* (machineHosts) {
        yield* settings.updateSettings({ machineHosts });
      }),
      hostChanges: settings.streamChanges.pipe(Stream.map((current) => current.machineHosts)),
      profiles: Effect.fn("ServerMachinePlatform.profiles")(function* (projectId) {
        return resolveProjectSettings(yield* settings.getSettings, projectId).settings
          .machineProfiles;
      }),
      projectExists: Effect.fn("ServerMachinePlatform.projectExists")(function* (
        projectId: ProjectId,
      ) {
        const rows = yield* sql`
          SELECT deleted_at FROM projection_projects WHERE project_id = ${projectId}
        `.pipe(
          Effect.flatMap(decodeRows),
          Effect.mapError(
            (cause) => new MachinePlatformError({ operation: `read project ${projectId}`, cause }),
          ),
          NodeSqliteClient.readOnly,
        );
        return rows[0] !== undefined && rows[0].deleted_at === null;
      }),
      run: Effect.fn("ServerMachinePlatform.run")(function* (command, args) {
        const { code, stdout, stderr } = yield* runner
          .run({ command, args })
          .pipe(
            Effect.mapError(
              (cause) => new MachinePlatformError({ operation: `run ${command}`, cause }),
            ),
          );
        return { code, stdout, stderr };
      }),
    });
  }),
);
