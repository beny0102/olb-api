import { leagueImportMain } from "../transfer/cli.js";

process.exitCode = await leagueImportMain(process.argv.slice(2));
