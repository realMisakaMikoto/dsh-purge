import { pathToFileURL } from "node:url";
import { assertRuntime } from "./runtime-check.js";
import { installFileJournal } from "./file-journal.js";
assertRuntime();
installFileJournal(process.env.DSH_PURGE_JOURNAL);
const { reapplyInstalled } = await import(pathToFileURL(process.env.DSH_PURGE_TARGET_REAPPLY).href);
const result = await reapplyInstalled({ scheduleSwap: false });
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.ok ? 0 : 1;
