import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PAYLOAD_NAMES, digest, load } from "../lib/update-transaction.js";
import { runOperation } from "../lib/update-worker.js";

// All downloads and host actions are replaced by disposable fixtures.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-community-update-"));
const repo = "realMisakaMikoto/dsh-purge";
const homeBefore = process.env.DSH_HOME;
const requestBefore = https.request;
const requests = [];
const home = path.join(temp, "home");
fs.mkdirSync(home);
process.env.DSH_HOME = home;
let corrupt = false, offline = false, groups = 0;
const pass = (label) => { groups++; console.log("PASS " + label); };
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function copyPlugin(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of PAYLOAD_NAMES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) fs.cpSync(file, path.join(dest, name), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
  pkg.version = "1.1.72";
  fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}
try {
  const source = path.join(temp, "source"), live = path.join(temp, "live");
  copyPlugin(source);
  git(source, "init", "-b", "master");
  git(source, "config", "user.name", "Updater fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "add", "."); git(source, "commit", "-m", "Original");
  execFileSync("git", ["clone", "--quiet", source, live], { windowsHide: true });
  const originalOrigin = path.join(temp, "unused-origin.git");
  git(live, "remote", "set-url", "origin", originalOrigin);
  git(live, "config", "url." + source.replace(/\\/g, "/") + ".insteadOf", "https://github.com/" + repo + ".git");
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  pkg.version = "1.1.73";
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(path.join(source, "lib/update-fixture.txt"), "new library");
  fs.writeFileSync(path.join(source, "scripts/update-fixture.txt"), "new script");
  fs.writeFileSync(path.join(source, "skills/update-fixture.txt"), "new skill");
  git(source, "add", "."); git(source, "commit", "-m", "Published fixture"); git(source, "tag", "v1.1.73");
  const sha = git(source, "rev-parse", "HEAD");
  const zip = execFileSync("git", ["-C", source, "archive", "--format=zip", "--prefix=dsh-purge-1.1.73/", "HEAD"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const asset = { name: "dsh-purge-1.1.73.zip", state: "uploaded", size: zip.length, digest: "sha256:" + digest(zip),
    browser_download_url: "https://github.com/" + repo + "/releases/download/v1.1.73/dsh-purge-1.1.73.zip" };
  const release = { tag_name: "v1.1.73", published_at: "2026-01-01", target_commitish: sha, assets: [asset] };
  https.request = (url, options, callback) => {
    const address = String(url); requests.push(address);
    assert.ok(address.includes(repo), "Unexpected update source: " + address);
    let status = 200, body;
    if (address.includes("/releases?")) {
      if (offline) { status = 503; body = "offline"; }
      else body = JSON.stringify([
        { ...release, tag_name: "v9.0.0", draft: true },
        { ...release, tag_name: "v8.0.0", prerelease: true },
        { ...release, tag_name: "v7.0.0", assets: [] }, release,
      ]);
    } else if (address.includes("/releases/download/")) body = corrupt ? Buffer.from("broken archive") : zip;
    else if (address.endsWith("/commits/v1.1.73")) body = JSON.stringify({ sha });
    else if (address.includes("/commits/beta")) { status = 404; body = "missing beta"; }
    else if (address.includes("/commits/v1.1.73.atom")) body = "<id>tag:github.com,2008:Grit::Commit/" + sha + "</id>";
    else if (address.includes("package.json")) body = JSON.stringify({ version: "1.1.73" });
    else throw new Error("Unexpected request: " + address);
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = (error) => req.emit("error", error);
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.headers = {}; res.resume = () => {};
      callback(res); res.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body)); res.emit("end");
    });
    return req;
  };
  const updater = await import(pathToFileURL(path.join(live, "lib/update.js")).href);
  const checked = await updater.checkUpdate();
  assert.equal(checked.remoteVersion, "1.1.73"); assert.equal(checked.hasUpdate, true);
  assert.ok(!checked.versions.some((item) => ["9.0.0", "8.0.0", "7.0.0"].includes(item.version)));
  assert.ok(!requests.some((url) => /\/commits\/(?:master|main)(?:$|\.)/.test(url)));
  pass("stable chooses complete published Releases and never follows master");
  const state = { surface: "web", ai_base: path.join(temp, "host") };
  const queued = await updater.applyUpdate([{ kind: "git", dir: live }], { ref: "master", launch: false, state });
  assert.equal(queued.verification_pending, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, "package.json"), "utf8")).version, "1.1.72");
  assert.equal(fs.existsSync(path.join(home, "dsh-purge/installed-rev")), false);
  const journalPath = path.join(home, "dsh-purge/operations", queued.operation_id, "journal.json");
  const staged = load(journalPath); assert.equal(staged.target.sha, sha); assert.equal(staged.target.ref, "v1.1.73");
  const fixtureActions = { stop: async () => {}, start: async () => {}, wait: async () => {}, reapply: async () => {} };
  const result = await runOperation(journalPath, fixtureActions);
  assert.equal(result.phase, "verified", result.error);
  assert.equal(git(live, "rev-parse", "HEAD"), sha); assert.equal(git(live, "remote", "get-url", "origin"), originalOrigin);
  assert.equal(fs.readFileSync(path.join(live, "scripts/update-fixture.txt"), "utf8"), "new script");
  assert.equal(fs.readFileSync(path.join(live, "skills/update-fixture.txt"), "utf8"), "new skill");
  pass("Git installation stages before mutation, verifies, retains origin, and includes scripts/skills");
  const archive = path.join(temp, "archive"), installed = path.join(temp, "installed"), profile = path.join(home, "profiles/web");
  copyPlugin(archive); copyPlugin(installed); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ dependencies: { "dsh-purge": "old" } }));
  const pending = await updater.applyUpdate([{ kind: "zip", dir: archive }, { kind: "dsh", dir: installed, profileDir: profile }],
    { ref: "v1.1.73", pin: "v1.1.73", launch: false, state, primary: installed });
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "package.json"))).dependencies["dsh-purge"], "old");
  const archiveResult = await runOperation(path.join(home, "dsh-purge/operations", pending.operation_id, "journal.json"), fixtureActions);
  assert.equal(archiveResult.phase, "verified", archiveResult.error);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "package.json"))).dependencies["dsh-purge"], "https://codeload.github.com/" + repo + "/tar.gz/" + sha);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "dsh-purge/channel.json"))).pin, "v1.1.73");
  pass("archive/profile updates use the same pinned commit and defer profile state until verification");
  corrupt = true;
  await assert.rejects(updater.applyUpdate([{ kind: "zip", dir: archive }], { ref: "stable", launch: false, state, primary: archive }), /checksum/);
  assert.equal(fs.readFileSync(path.join(archive, "scripts/update-fixture.txt"), "utf8"), "new script");
  pass("corrupted downloads fail before changing any installation");
  corrupt = false; offline = true;
  await assert.rejects(updater.checkUpdate(), /503/);
  assert.ok(!requests.some((url) => /\/(?:zip|tar.gz)\/refs\/heads\/master/.test(url)));
  pass("network failures never substitute a branch for a published stable Release");
  console.log("ALL PASS (" + groups + " groups)");
} finally {
  https.request = requestBefore;
  if (homeBefore === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = homeBefore;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("dsh-community-update-"));
  fs.rmSync(temp, { recursive: true, force: true });
}
