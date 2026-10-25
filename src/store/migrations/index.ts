import { name as initName, sql as initSql, version as initVersion } from "./0001-init.js";
import {
  name as sessionsName,
  sql as sessionsSql,
  version as sessionsVersion,
} from "./0002-sessions.js";
import {
  name as ccusageName,
  sql as ccusageSql,
  version as ccusageVersion,
} from "./0003-ccusage-import.js";

/**
 * The store's numbered migrations, in application order. Each entry carries
 * { version, name, sql } from its numbered module; the runner applies any
 * pending ones inside a transaction and records them in schema_migrations.
 * A new migration appends a new numbered module's values here; STORE_VERSION
 * always equals the last entry's version.
 */
export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  { version: initVersion, name: initName, sql: initSql },
  { version: sessionsVersion, name: sessionsName, sql: sessionsSql },
  { version: ccusageVersion, name: ccusageName, sql: ccusageSql },
];
