import { main } from "../setup/cli.js";

process.exitCode = await main(process.argv.slice(2));
