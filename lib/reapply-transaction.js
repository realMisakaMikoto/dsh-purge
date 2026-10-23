import { pathToFileURL } from "node:url";
import path from "node:path";
import { assertRuntime } from "./runtime-check.js";
import { installFileJournal } from "./file-journal.js";
assertRuntime();
installFileJournal(process.env.DSH_PURGE_JOURNAL);
// The stable runner uses the selected version's patch engine and definitions.
// An unrelated old CLI installation must not block a desktop/profile update.
const library = path.dirname(process.env.DSH_PURGE_TARGET_REAPPLY);
const base = process.env.DSH_PURGE_TARGET_BASE;
if (!base || !path.isAbsolute(base)) throw new Error("A verified target host base is required");
const core = await import(pathToFileURL(path.join(library, "core.js")).href);
const hooks = await import(pathToFileURL(path.join(library, "hooks-deny.js")).href);
core.applyRuntimeEnv();
core.refreshStaleBaksForUpgrade(base);
const backup = await core.backupAll(base);
if (backup.errors?.length) throw new Error("Host backup failed: " + JSON.stringify(backup.errors));
const reverted = await core.revertAll(base, { preserveClientBundles: false });
if (reverted.errors?.length) throw new Error("Host restore failed: " + JSON.stringify(reverted.errors));
await core.revertAllShims();
const settings = core.getHooksDenySettings();
if (settings.hooksDenyBypass === false) {
  const restored = await core.restoreHookDenyForBases([base]);
  if (restored.failed?.length) throw new Error("Hook-deny restore failed");
}
const report = await core.applyPatches(base, hooks.selectPatches(core.ALL_PATCHES, settings), { preserveClientBundles: false, forApply: true });
await core.patchAllShims();
const flash = core.silenceCmdFlash(base);
const summary = core.summarizeApplyReport(report);
const result = { ok: summary.failed.length === 0 && core.hostCleanMarkersPresent(base),
  error: summary.failed.length ? "Selected host patch application failed" : "",
  applied: summary.applied, failed: summary.failed.length, failed_items: summary.failed, cmdFlashOk: flash.ok === true };
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.ok ? 0 : 1;
