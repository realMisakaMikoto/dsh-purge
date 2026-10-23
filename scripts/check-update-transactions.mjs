import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as journal from "../lib/update-transaction.js";
import { runOperation } from "../lib/update-worker.js";
import { bootMatches } from "../lib/operation-boot.js";
import { runtimeChecks, supportedNode } from "../lib/runtime-check.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-transaction-"));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let groups = 0;
const pass = (message) => { groups++; console.log("PASS " + message); };
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function payload(dir, version) {
  write(path.join(dir, "package.json"), JSON.stringify({ name: "dsh-purge", version, type: "module" }));
  for (const name of ["lib/index.js", "lib/reapply-cli.js", "bin/dsh-purge.js", "client.js", "presets/redteam/preset.yml", "scripts/redteam-setup.sh", "skills/redteam/example/SKILL.md"]) write(path.join(dir, name), "version " + version);
}
function fixture(name) {
  const dir = path.join(temp, name);
  const home = path.join(dir, "home");
  const plugin = path.join(dir, "plugin");
  const source = path.join(dir, "source");
  const runtime = path.join(dir, "resources/runtime");
  fs.mkdirSync(home, { recursive: true });
  payload(plugin, "1.0.0"); payload(source, "1.1.0");
  write(path.join(plugin, "lib/obsolete.js"), "old");
  write(path.join(plugin, "node_modules/dependency/file"), "dependency");
  write(path.join(runtime, "office/SKILL.md"), "runtime sentinel");
  write(path.join(home, "redteam/data.db"), "database sentinel");
  const metadata = path.join(home, "profile/package.json");
  write(metadata, "old metadata");
  const tx = journal.createTransaction(home, { target: { version: "1.1.0", sha: "a".repeat(40) }, previous: { version: "1.0.0", sha: "" },
    primary: plugin, old_pid: 99999999, surface: "web", profile: "web", ai_base: path.join(dir, "host"), git: [],
    restart: { execPath: process.execPath }, metadata: [{ path: metadata, content: "new metadata" }] });
  journal.preparePayload(tx, source, [plugin, plugin]);
  journal.capture(tx, metadata, "metadata");
  return { dir, home, plugin, source, runtime, metadata, tx, file: path.join(tx.dir, "journal.json") };
}
const adapters = { stop: async () => {}, start: async (tx, recovery) => journal.phase(tx, recovery ? "waiting_recovery" : "waiting_boot", { attempt_started: Date.now() }), wait: async () => {}, reapply: async () => {} };
try {
  {
    const fx = fixture("success");
    let sawOldMetadata = false;
    const result = await runOperation(fx.file, { ...adapters, wait: async () => {
      assert.equal(fs.readFileSync(fx.metadata, "utf8"), "old metadata"); sawOldMetadata = true;
    } });
    assert.equal(result.phase, "verified"); assert.equal(sawOldMetadata, true);
    assert.equal(fs.readFileSync(fx.metadata, "utf8"), "new metadata");
    assert.equal(journal.readJson(path.join(fx.plugin, "package.json")).version, "1.1.0");
    assert.equal(fs.existsSync(path.join(fx.plugin, "lib/obsolete.js")), false);
    assert.equal(fs.readFileSync(path.join(fx.plugin, "skills/redteam/example/SKILL.md"), "utf8"), "version 1.1.0");
    assert.equal(fs.readFileSync(path.join(fx.plugin, "scripts/redteam-setup.sh"), "utf8"), "version 1.1.0");
    assert.equal(fs.readFileSync(path.join(fx.plugin, "node_modules/dependency/file"), "utf8"), "dependency");
    assert.equal(result.destinations.length, 1);
    pass("full payload, obsolete files, shared destinations, dependencies, and deferred metadata");
  }
  {
    const fx = fixture("\u4e2d\u6587 path with spaces");
    const result = await runOperation(fx.file, adapters);
    assert.equal(result.phase, "verified", result.error);
    pass("non-ASCII and space-containing installation paths");
  }
  for (const failure of ["reapply", "startup", "disk-write", "staged-corruption"]) {
    const fx = fixture(failure);
    const sentinel = path.join(fx.runtime, "office/SKILL.md");
    const before = journal.digest(fs.readFileSync(sentinel));
    let recoveries = 0;
    if (failure === "staged-corruption") write(path.join(fx.source, "skills/redteam/example/SKILL.md"), "corrupt");
    const result = await runOperation(fx.file, {
      ...adapters,
      reapply: async (tx) => {
        journal.replaceFile(tx, sentinel, "temporary CLI-like host edit", "host");
        if (failure === "reapply" || failure === "disk-write") throw new Error(failure === "disk-write" ? "ENOSPC injected" : "pattern failed");
      },
      wait: async (_tx, recovery) => {
        if (recovery) recoveries++;
        else if (failure === "startup") throw new Error("startup timeout injected");
      },
    });
    assert.equal(result.phase, "rolled_back", result.error);
    assert.equal(recoveries, 1);
    assert.equal(journal.readJson(path.join(fx.plugin, "package.json")).version, "1.0.0");
    assert.equal(fs.readFileSync(fx.metadata, "utf8"), "old metadata");
    assert.equal(journal.digest(fs.readFileSync(sentinel)), before);
    assert.equal(fs.readFileSync(path.join(fx.home, "redteam/data.db"), "utf8"), "database sentinel");
    pass(failure + " restores plugin, exact host files, metadata, runtime, and user data");
  }
  {
    const fx = fixture("recovery-limit");
    let starts = 0;
    const result = await runOperation(fx.file, { ...adapters, start: async (tx, recovery) => {
      starts++; await adapters.start(tx, recovery);
    }, wait: async () => { throw new Error("always unhealthy"); } });
    assert.equal(result.phase, "failed"); assert.equal(starts, 2);
    assert.equal(result.recovery_attempted, true);
    pass("failed recovery stops after one new-host and one recovery launch");
  }
  {
    const fx = fixture("interrupted");
    journal.installPayload(fx.tx); fx.tx.host_stopped = true; journal.save(fx.tx);
    const result = await runOperation(fx.file, { ...adapters, recover: true });
    assert.equal(result.phase, "rolled_back");
    assert.equal(journal.readJson(path.join(fx.plugin, "package.json")).version, "1.0.0");
    pass("interrupted durable journal resumes restoration instead of retrying installation");
  }
  {
    const fx = fixture("write-journal");
    const host = path.join(fx.runtime, "cli/bin/dsh.cmd");
    write(host, "original shim");
    const source = "import fs from 'node:fs'; import {installFileJournal} from " + JSON.stringify(pathToFileURL(path.join(root, "lib/file-journal.js")).href) + "; installFileJournal(process.argv[1]); const p=process.argv[2]; fs.writeFileSync(p+'.tmp','changed shim'); fs.renameSync(p+'.tmp',p); try { fs.rmSync(process.argv[3],{recursive:true,force:true}); process.exit(9); } catch(e) { if(!/regular files/.test(e.message)) throw e; }";
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", source, fx.file, host, fx.runtime], { encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const tx = journal.load(fx.file); journal.restoreFiles(tx);
    assert.equal(fs.readFileSync(host, "utf8"), "original shim");
    assert.equal(fs.readFileSync(path.join(fx.runtime, "office/SKILL.md"), "utf8"), "runtime sentinel");
    journal.phase(tx, "rolled_back"); journal.releaseLocks(tx);
    pass("real isolated filesystem journal restores atomic renames and rejects directory removal");
  }
  {
    const fx = fixture("boot-proof");
    fx.tx.attempt_started = Date.now();
    const report = { nonce: fx.tx.nonce, pid: 424242, started_at: Date.now() + 1, version: fx.tx.target.version, sha: fx.tx.target.sha,
      profile: fx.tx.profile, surface: fx.tx.surface, ai_base: fx.tx.ai_base, patches_active: true, activation_pending: false, patches_pending: 0 };
    assert.equal(bootMatches(fx.tx, report), true);
    for (const change of [{ pid: fx.tx.old_pid }, { nonce: "wrong" }, { version: "old" }, { sha: "old" }, { profile: "desktop" },
      { surface: "desktop" }, { ai_base: fx.home }, { patches_active: false }, { activation_pending: true }, { patches_pending: 1 }, { started_at: 0 }]) {
      assert.equal(bootMatches(fx.tx, { ...report, ...change }), false);
    }
    assert.throws(() => journal.createTransaction(fx.home), /active/);
    journal.phase(fx.tx, "failed"); journal.releaseLocks(fx.tx);
    pass("boot proof rejects old processes, wrong identity/profile/host, inactive patches, and overlapping operations");
  }
  {
    const fx = fixture("links");
    journal.phase(fx.tx, "failed"); journal.releaseLocks(fx.tx);
    const linked = path.join(fx.plugin, "skills/link");
    fs.symlinkSync(fx.runtime, linked, "junction");
    const tx = journal.createTransaction(fx.home, { target: { version: "1.1.0", sha: "a".repeat(40) } });
    assert.throws(() => journal.preparePayload(tx, fx.source, [fx.plugin]), /link/);
    assert.equal(fs.readFileSync(path.join(fx.runtime, "office/SKILL.md"), "utf8"), "runtime sentinel");
    journal.phase(tx, "failed"); journal.releaseLocks(tx);
    pass("payload links to runtime are refused before any installation mutation");
  }
  {
    const fx = fixture("retention");
    journal.phase(fx.tx, "verified"); journal.releaseLocks(fx.tx);
    const transactions = [fx.tx];
    for (let i = 1; i <= 3; i++) {
      const tx = journal.createTransaction(fx.home, { kind: "update", destinations: [fx.plugin] });
      tx.created_at = "2026-01-0" + (i + 1) + "T00:00:00.000Z";
      journal.phase(tx, "verified"); journal.releaseLocks(tx); transactions.push(tx);
    }
    fx.tx.created_at = "2026-01-01T00:00:00.000Z"; journal.save(fx.tx);
    const old = transactions[0];
    fs.symlinkSync(fx.runtime, path.join(old.dir, "runtime-link"), "junction");
    const warnings = journal.pruneBackups(fx.home);
    assert.ok(warnings.length > 0); assert.equal(fs.existsSync(old.dir), true);
    assert.equal(fs.existsSync(transactions[1].dir), false);
    assert.equal(fs.existsSync(transactions[2].dir), true);
    assert.equal(fs.existsSync(transactions[3].dir), true);
    assert.equal(fs.readFileSync(path.join(fx.runtime, "office/SKILL.md"), "utf8"), "runtime sentinel");
    pass("retention keeps two backups and preserves suspicious linked backups without touching runtime");
  }
  {
    const dir = path.join(temp, "git-edits");
    fs.mkdirSync(dir);
    const run = (...args) => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    run("init"); run("config", "user.name", "Fixture"); run("config", "user.email", "fixture@example.invalid");
    write(path.join(dir, "file"), "original"); run("add", "."); run("commit", "-m", "initial");
    assert.ok(journal.gitState(dir));
    write(path.join(dir, "untracked"), "local"); assert.throws(() => journal.gitState(dir), /Local plugin edits/);
    fs.unlinkSync(path.join(dir, "untracked")); write(path.join(dir, "file"), "modified");
    assert.throws(() => journal.gitState(dir), /Local plugin edits/);
    pass("both tracked and untracked Git edits stop updates");
  }
  assert.equal(supportedNode("18.20.0"), false); assert.equal(supportedNode("22.12.0"), false);
  assert.equal(supportedNode("22.13.0"), true); assert.equal(supportedNode("24.0.0"), true);
  assert.ok((await runtimeChecks()).every((row) => row.ok));
  pass("minimum Node boundary and real SQLite read/write capabilities");
  console.log("ALL PASS (" + groups + " groups)");
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("dsh-transaction-"));
  fs.rmSync(temp, { recursive: true, force: true });
}
