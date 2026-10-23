import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag = "v" + pkg.version;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const run = (...args) => execFileSync("gh", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const existing = spawnSync("gh", ["release", "view", tag, "--json", "isDraft,targetCommitish,assets"], { encoding: "utf8" });
if (existing.status === 0) {
  const release = JSON.parse(existing.stdout);
  if (!release.isDraft) { console.log("Already published: " + tag); process.exit(0); }
  if (release.targetCommitish !== sha || release.assets.length) throw new Error("Existing draft requires inspection; no assets overwritten");
}
const notes = fs.readFileSync("release-notes.md", "utf8").replace(/\r\n/g, "\n");
if (!notes.startsWith("# " + pkg.version + "\n")) throw new Error("Release notes/version mismatch");
fs.writeFileSync("release-body.txt", notes.split(/\n# /)[0].trim() + "\n");
const zip = "dsh-purge-" + pkg.version + ".zip";
execFileSync("git", ["archive", "--format=zip", "--prefix=dsh-purge-" + pkg.version + "/", "--output=" + zip, sha]);
const digest = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
fs.writeFileSync("SHA256SUMS", digest + "  " + zip + "\n");
if (existing.status !== 0) run("release", "create", tag, "--target", sha, "--title", tag, "--draft", "--notes-file", "release-body.txt");
run("release", "upload", tag, zip, "SHA256SUMS");
const release = JSON.parse(run("release", "view", tag, "--json", "assets"));
if (![zip, "SHA256SUMS"].every((name) => release.assets.some((asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0))) throw new Error("Release assets are incomplete");
const uploaded = release.assets.find((asset) => asset.name === zip);
if (uploaded.digest && uploaded.digest !== "sha256:" + digest) throw new Error("Uploaded archive checksum mismatch");
run("release", "edit", tag, "--draft=false", ...(/(?:alpha|beta|rc)/i.test(pkg.version) ? ["--prerelease"] : ["--latest"]));
console.log("Published " + tag + " at " + sha + " (SHA-256 " + digest + ")");
