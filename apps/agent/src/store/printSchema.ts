// `pnpm db:generate`: prints the migration SQL. Schema lives in store/db.ts (node:sqlite, see docs/decisions.md).
import { MIGRATION_SQL } from "./db";

MIGRATION_SQL.forEach((m, i) => console.log(`-- migration ${i + 1}\n${m.trim()}\n`));
