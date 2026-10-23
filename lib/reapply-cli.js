import { assertRuntime } from "./runtime-check.js";
assertRuntime();
if (process.env.DSH_PURGE_JOURNAL) {
  const { installFileJournal } = await import("./file-journal.js");
  installFileJournal(process.env.DSH_PURGE_JOURNAL);
}
const { reapplyInstalled } = await import("./reapply.js");

const result = await reapplyInstalled({ scheduleSwap: !process.env.DSH_PURGE_JOURNAL });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
