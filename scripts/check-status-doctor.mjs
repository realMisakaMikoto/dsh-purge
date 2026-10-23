import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-status-doctor-"));
const keys = ["DSH_HOME", "DSH_BASE", "DSH_SURFACE", "DSH_DESKTOP_INSTALL", "APPDATA", "LOCALAPPDATA"];
const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const oldCwd = process.cwd();
const oldExec = childProcess.execFileSync;
let runningExes = [];
let groups = 0;
const pass = (name) => { groups += 1; console.log("PASS " + name); };
const write = (fp, text) => { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, text); };
const key = (fp) => {
  let resolved = path.resolve(fp);
  try { resolved = fs.realpathSync.native(fp); } catch { /* Missing fixture paths keep their absolute form. */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
try {
  const home = path.join(temp, "home");
  const web = path.join(temp, "web/node_modules/@deepseek-ai");
  const installations = ["installed", "running"].map((name) => path.join(temp, name, "DeepSeek Harness"));
  const bases = installations.map((dir) => path.join(dir, "resources/app/dsh/node_modules/@deepseek-ai"));
  const prompt = "// system-prompt/assemble\n// [dsh-purge] identity stripped\n// [dsh-purge] complete prompt keeps waterfall inject\n";
  for (const base of [web, ...bases]) {
    write(path.join(base, "dsh-agent-instructions/lib/index.js"), "// FIXTURE_PATCH\n");
    write(path.join(base, "dsh-system-prompt/lib/index.js"), prompt);
  }
  for (const dir of installations) {
    write(path.join(dir, "DeepSeek Harness.exe"), "fixture, never executed");
    write(path.join(dir, "resources/app/lib/main.js"), "// fixture shell\n");
    write(path.join(dir, "resources/runtime/cli/bin/dsh.cmd"), "@echo off\n");
  }
  write(path.join(installations[0], "resources/app.asar"), "sealed fixture");
  fs.mkdirSync(home);
  process.env.DSH_HOME = home;
  process.env.DSH_BASE = web;
  delete process.env.DSH_SURFACE;
  process.env.DSH_DESKTOP_INSTALL = installations[0];
  process.env.APPDATA = path.join(temp, "appdata");
  process.env.LOCALAPPDATA = path.join(temp, "localappdata");
  process.chdir(temp);
  childProcess.execFileSync = (command, args, options) => {
    if (command === "powershell.exe") {
      return args.join(" ").includes("Get-CimInstance Win32_Process") ? JSON.stringify(runningExes) : "[]";
    }
    return oldExec(command, args, options);
  };
  syncBuiltinESMExports();
  const core = await import(pathToFileURL(path.join(root, "lib/core.js")).href);
  const doctor = await import(pathToFileURL(path.join(root, "lib/doctor.js")).href);

  const selected = await core.gatherState({ base: bases[0], hosts: true, discover: false });
  assert.equal(selected.surface, "desktop");
  assert.equal(selected.asar_still_sealed, true);
  assert.equal(selected.patches_active, false);
  assert.equal(selected.activation_pending, true);
  assert.notEqual(selected.patch_status[45], "na");
  assert.equal(key(selected.files["desktop-shell"]), key(path.join(installations[0], "resources/app/lib/main.js")));
  assert.equal(doctor.runChecks({ state: selected }).rows.find((row) => row.id === "asar").ok, false);
  pass("a desktop selected from Node retains ASAR, shell, applicability, and activation checks");

  const idle = await core.gatherState({ hosts: true, discover: true });
  assert.equal(key(idle.ai_base), key(web));
  assert.ok(idle.hosts.every((host) => !host.running_app));
  pass("an installed but idle desktop does not replace the Web host");

  if (process.platform === "win32") {
    runningExes = [path.join(installations[1], "DeepSeek Harness.exe")];
    const active = await core.gatherState({ hosts: true, discover: true });
    assert.equal(key(active.ai_base), key(bases[1]));
    assert.equal(active.asar_still_sealed, false);
    assert.equal(active.hosts.find((host) => key(host.ai_base) === key(bases[0])).running_app, false);
    const primary = active.hosts.find((host) => host.is_primary);
    assert.equal(primary.running_app, true);
    assert.equal(primary.total, active.patches_total);
    assert.equal(primary.ready, active.patches_ready);
    pass("only the actual running installation becomes primary; host totals remain consistent");
  }
  const forced = await core.gatherState({ surface: "web", hosts: true, discover: true });
  assert.equal(forced.surface, "web");
  assert.equal(key(forced.ai_base), key(web));
  const explicit = await core.gatherState({ base: bases[0], hosts: true, discover: true });
  assert.equal(key(explicit.ai_base), key(bases[0]));
  assert.equal(explicit.asar_still_sealed, true);
  pass("explicit surface/base choices override automatic running-host selection");

  const alias = path.join(temp, "desktop-alias");
  fs.symlinkSync(bases[0], alias, process.platform === "win32" ? "junction" : "dir");
  const aliased = await core.gatherState({ base: alias, hosts: true, discover: true });
  assert.equal(aliased.surface, "desktop");
  assert.equal(aliased.hosts.filter((host) => key(fs.realpathSync.native(host.ai_base)) === key(bases[0])).length, 1);
  const patch = { id: 999, file: "agent-instructions", surfaces: ["desktop"], markers: ["FIXTURE_PATCH"], replacements: [] };
  assert.equal((await core.patchStatus(bases[0], [patch], "desktop"))[999], "applied");
  assert.equal((await core.patchStatus(bases[0], [patch], "web"))[999], "na");
  pass("junctions deduplicate and per-host patch applicability uses the selected surface");

  const repo = path.join(temp, "repo");
  write(path.join(repo, "package.json"), JSON.stringify({ name: "dsh-purge", exports: { "./package.json": "./package.json" } }));
  const copied = path.join(temp, "copied");
  fs.mkdirSync(copied);
  const healthy = { ai_base: web, dsh_home: home, surface: "web", patches_active: true, patches_applied: 5, patches_total: 5, patches_pending: 0, patches_ready: 5, has_backup: true, shim_cmd: "original", asar_still_sealed: false, files: {}, patch_status: {} };
  const badLinks = doctor.runChecks({ state: healthy, repo, linkPaths: [copied, path.join(temp, "missing")] });
  assert.equal(badLinks.ok, false);
  assert.ok(badLinks.rows.filter((row) => row.id.startsWith("link:")).every((row) => !row.ok));
  const relative = path.join(temp, "relative/dsh-purge");
  fs.mkdirSync(path.dirname(relative));
  fs.symlinkSync(path.relative(path.dirname(relative), repo), relative, "dir");
  assert.equal(key(doctor.linkTarget(relative)), key(repo));
  assert.equal(doctor.runChecks({ state: healthy, repo, linkPaths: [relative] }).ok, true);
  pass("missing/copied installations fail while valid relative symlinks pass");

  assert.equal(doctor.runChecks({ state: { ...healthy, patches_active: false } }).ok, false);
  assert.equal(doctor.runChecks({ state: healthy, baseline: { applied: 6 } }).ok, false);
  assert.equal(doctor.runChecks({ state: healthy, baseline: { ai_base: copied, applied: 5 } }).ok, false);
  pass("inactive patches, baseline regressions, and baselines from another host fail health checks");

  // Test the real CLI wiring against a stub host. Mutating host operations are never provided.
  const cliRoot = path.join(temp, "cli");
  fs.mkdirSync(path.join(cliRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(cliRoot, "lib"));
  fs.copyFileSync(path.join(root, "bin/dsh-purge.js"), path.join(cliRoot, "bin/dsh-purge.js"));
  fs.copyFileSync(path.join(root, "lib/doctor.js"), path.join(cliRoot, "lib/doctor.js"));
  fs.copyFileSync(path.join(root, "lib/runtime-check.js"), path.join(cliRoot, "lib/runtime-check.js"));
  write(path.join(cliRoot, "package.json"), '{"type":"module"}');
  const stateFile = path.join(cliRoot, "state.json");
  write(stateFile, JSON.stringify(healthy));
  write(path.join(cliRoot, "lib/core.js"), `import fs from 'node:fs';
export const ALL_PATCHES = [];
export const missingAiBaseMessage = () => 'No fixture host';
export async function gatherState(options) {
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  return options.base && options.base !== state.ai_base ? { ...state, ai_base: null, patches_active: false, patches_applied: 0 } : state;
}`);
  write(path.join(cliRoot, "lib/rules.js"), "export function resolveInjectText() { throw new Error('Mutation must not be reached'); }\n");
  const run = (...args) => childProcess.spawnSync(process.execPath, [path.join(cliRoot, "bin/dsh-purge.js"), ...args], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env } });
  const bad = run("--doctor", "--save-baseline", "--base", "missing", "--json");
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.ok(!fs.existsSync(doctor.baselinePath(home)));
  const saved = run("--doctor", "--save-baseline", "--json");
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).ok, true);
  assert.equal(doctor.readBaseline(home).applied, 5);
  write(stateFile, JSON.stringify({ ...healthy, patches_applied: 4 }));
  const regressed = run("--doctor", "--json");
  assert.equal(regressed.status, 1);
  assert.equal(JSON.parse(regressed.stdout).rows.find((row) => row.id === "patches").ok, false);
  pass("doctor CLI returns real exit codes and saves only a healthy baseline");

  write(stateFile, JSON.stringify(healthy));
  const pluginLink = path.join(home, "plugins/dsh-purge");
  const moduleLink = path.join(home, "profiles/web/node_modules/dsh-purge");
  for (const link of [pluginLink, moduleLink]) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  }
  const linked = run("--doctor", "--repo", repo, "--json");
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(JSON.parse(linked.stdout).rows.filter((row) => row.id.startsWith("link:")).length, 2);
  fs.unlinkSync(pluginLink);
  const missingLink = run("--doctor", "--repo", repo, "--json");
  assert.equal(missingLink.status, 1);
  const jsonApply = run("--apply", "--json");
  assert.notEqual(jsonApply.status, 0);
  assert.equal(JSON.parse(jsonApply.stdout).ok, false);
  assert.equal(run("--apply", "--base", "missing").status, 1);
  assert.notEqual(run("--surface", "unknown", "--json").status, 0);
  assert.equal(run("--status", "--json").status, 0);
  pass("repo checks reach the CLI, JSON cannot silently skip Apply, and status JSON remains available");
  console.log(`ALL PASS (${groups} groups)`);
} finally {
  childProcess.execFileSync = oldExec;
  syncBuiltinESMExports();
  process.chdir(oldCwd);
  for (const name of keys) {
    if (oldEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldEnv[name];
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
