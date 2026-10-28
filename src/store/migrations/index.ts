import { name as initName, sql as initSql, version as initVersion } from "./0001-init.js";
import {
  name as sessionsName,
  sql as sessionsSql,
  version as sessionsVersion,
} from "./0002-sessions.js";
import {
  name as envelopesName,
  sql as envelopesSql,
  version as envelopesVersion,
} from "./0004-envelopes.js";
import {
  name as requestEndpointName,
  sql as requestEndpointSql,
  version as requestEndpointVersion,
} from "./0005-request-endpoint.js";
import {
  name as localUsageName,
  sql as localUsageSql,
  version as localUsageVersion,
} from "./0006-local-usage.js";

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

// Migration 0003 (imported usage, #73) was removed with the ccusage import
// lane (#118). It stays unregistered: fresh stores skip straight to 0004,
// and existing stores that already applied 0003 keep their legacy tables —
// the runner only consults schema_migrations, so nothing re-runs or drops.
export const MIGRATIONS: readonly Migration[] = [
  { version: initVersion, name: initName, sql: initSql },
  { version: sessionsVersion, name: sessionsName, sql: sessionsSql },
  { version: envelopesVersion, name: envelopesName, sql: envelopesSql },
  { version: requestEndpointVersion, name: requestEndpointName, sql: requestEndpointSql },
  { version: localUsageVersion, name: localUsageName, sql: localUsageSql },
];
