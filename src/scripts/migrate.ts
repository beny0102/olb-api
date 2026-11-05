import { runMigrations } from "../store/migrations.js";
import { createPool } from "../store/pg.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = createPool(url);
  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log("no pending migrations");
    } else {
      console.log(`applied migrations: ${applied.join(", ")}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`migrate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
