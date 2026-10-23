import fs from "node:fs";
import path from "node:path";
import { load, latestOperation, publicOperation, readJson } from "./update-transaction.js";
import { supportedNode } from "./runtime-check.js";

export function operationStatus(home) { return publicOperation(latestOperation(home)); }
export function bootVerificationPending(home) {
  if (!process.env.DSH_PURGE_OPERATION || !process.env.DSH_PURGE_BOOT_NONCE) return false;
  const tx = latestOperation(home);
  return Boolean(tx && tx.id === process.env.DSH_PURGE_OPERATION && tx.nonce === process.env.DSH_PURGE_BOOT_NONCE
    && !["verified", "rolled_back", "failed"].includes(tx.phase));
}

export function bootMatches(tx, report, recovery = false) {
  const expected = recovery ? tx.previous : tx.target;
  const normalize = (value) => {
    let resolved = path.resolve(value || ".");
    try { resolved = fs.realpathSync.native(resolved); } catch { /* A missing path cannot match. */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return Boolean(report && report.nonce === tx.nonce && report.pid !== tx.old_pid
    && report.started_at >= tx.attempt_started && report.version === expected.version
    && (!expected.sha || report.sha === expected.sha)
    && report.profile === tx.profile && report.surface === tx.surface
    && normalize(report.ai_base) === normalize(tx.ai_base)
    && report.patches_active === true && report.activation_pending === false && report.patches_pending === 0);
}

export async function reportBoot(home, root, collectState) {
  const id = process.env.DSH_PURGE_OPERATION;
  const nonce = process.env.DSH_PURGE_BOOT_NONCE;
  if (!id || !nonce || !supportedNode()) return false;
  const file = path.join(home, "dsh-purge", "operations", id, "journal.json");
  const tx = load(file);
  if (nonce !== tx.nonce || !["waiting_boot", "waiting_recovery"].includes(tx.phase)) return false;
  if (!tx.destinations?.some((dest) => fs.realpathSync.native(dest) === fs.realpathSync.native(root))) return false;
  const state = await collectState();
  const pkg = readJson(path.join(root, "package.json"));
  let sha = "";
  try { sha = fs.readFileSync(path.join(root, ".dsh-purge-revision"), "utf8").trim(); } catch { /* Legacy installation. */ }
  const report = { nonce, pid: process.pid, started_at: Date.now(), version: pkg?.version || "", sha,
    profile: process.env.DSH_PROFILE || state.surface, surface: state.surface, ai_base: state.ai_base,
    patches_active: state.patches_active === true, activation_pending: state.activation_pending === true,
    patches_pending: state.patches_pending };
  // A separate report avoids concurrent edits to the worker-owned journal.
  const reportFile = path.join(tx.dir, "boot-report.json");
  const tmp = reportFile + "." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(report) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, reportFile);
  return bootMatches(tx, report, tx.phase === "waiting_recovery");
}
