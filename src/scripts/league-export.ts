import { leagueExportMain } from "../transfer/cli.js";

process.exitCode = await leagueExportMain(process.argv.slice(2));
