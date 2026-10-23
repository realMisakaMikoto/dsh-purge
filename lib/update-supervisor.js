import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "./update-transaction.js";

const file = process.argv[2];
const worker = fileURLToPath(new URL("./update-worker.js", import.meta.url));
function run(recover) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, file, ...(recover ? ["--recover"] : [])], {
      stdio: "inherit", windowsHide: true, cwd: path.dirname(file), env: { ...process.env, DSH_PURGE_SUPERVISOR_PID: String(process.pid) },
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
await run(process.argv.includes("--recover"));
const tx = load(file);
if (!["verified", "rolled_back"].includes(tx.phase) && tx.host_stopped && !tx.recovery_attempted) await run(true);
