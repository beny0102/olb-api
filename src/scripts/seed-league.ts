import { seedLeague } from "./league-seed.js";
import { seedAuth, SEED_AUTH_EMAILS } from "../auth/auth-seed.js";
import { PostgresAuthStore } from "../auth/postgres-auth.store.js";
import { runMigrations } from "../store/migrations.js";
import { createPool } from "../store/pg.js";
import { PostgresLeagueStore } from "../store/postgres-league.store.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = createPool(url);
  try {
    const applied = await runMigrations(pool);
    if (applied.length > 0) {
      console.log(`applied migrations: ${applied.join(", ")}`);
    }

    const store = new PostgresLeagueStore(pool);
    await seedLeague(store);

    const authStore = new PostgresAuthStore(pool);
    await seedAuth(authStore);

    const organizations = await store.listOrganizations();
    const organization = organizations[0];
    if (!organization) {
      throw new Error("seed did not create an organization");
    }

    const seasons = await store.listSeasons(organization.id);
    const season = seasons[0];
    if (!season) {
      throw new Error("seed did not create a season");
    }

    const competitions = await store.listCompetitions(season.id);
    let teams = 0;
    let rosterEntries = 0;
    for (const competition of competitions) {
      const teamSeasons = await store.listTeams(competition.id);
      teams += teamSeasons.length;
      for (const teamSeason of teamSeasons) {
        rosterEntries += (await store.listRoster(teamSeason.id)).length;
      }
    }
    const games = await store.listGames(season.id);

    let authUsers = 0;
    let memberships = 0;
    for (const email of SEED_AUTH_EMAILS) {
      const user = await authStore.getUserByEmail(email);
      if (!user) continue;
      authUsers += 1;
      memberships += (await authStore.listMemberships(user.id)).length;
    }

    console.log(
      `seeded league: ${organizations.length} organization, ${seasons.length} season, ` +
        `${competitions.length} competitions, ${teams} teams, ` +
        `${rosterEntries} roster entries, ${games.length} games`,
    );
    console.log(`seeded auth: ${authUsers} users, ${memberships} memberships`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`seed-league failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
