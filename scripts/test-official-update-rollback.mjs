#!/usr/bin/env node
/**
 * 官方桌面更新交接的失败回滚回归测试（dsh-purge）
 *
 * 背景：official-update.wscript 在「安装失败 + 并发重建 app」分支里用
 *   fso.DeleteFolder(appDir, true) 递归删除重建出来的 resources\app。
 * FSO 的递归删除会**穿过 junction**（resources\app\runtime -> resources\runtime），
 * 把真实 runtime 的内容一起删掉，只留下空目录 —— 历史上表现为 office/SKILL.md 丢失。
 * Node 的 fs.rmSync 对同一结构只删链接本身。
 *
 * 本测试覆盖计划第五节的七个场景：
 *   1. 普通目录更新成功
 *   2. 带 app/runtime junction 的更新失败回滚
 *   3. 安装成功但 EXE/ASAR 大小不变
 *   4. 安装器非零退出码、资源不完整
 *   5. app 被并发重建、目录重命名失败、恢复旧 app 失败
 *   6. 隔离目录清理与重复执行
 *   7. 越界路径或顶层链接被拒绝清理
 *
 * 安全边界：全部夹具、junction、fake exe / fake installer 都在本次运行的临时目录内，
 * 测试不接触真实安装目录、不 taskkill 真实进程、不运行真实安装器。
 *
 * 用法：node scripts/test-official-update-rollback.mjs [--keep]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);
const KEEP = process.argv.includes("--keep");

const OFFICE_SKILLS = [
  "office/SKILL.md",
  "office-docx/SKILL.md",
  "office-pptx/SKILL.md",
  "office-xlsx/SKILL.md",
  "office-export-pdf/SKILL.md",
  "office-recalculate/SKILL.md",
  "office-render/SKILL.md",
];

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function sha256(fp) {
  try {
    return createHash("sha256").update(fs.readFileSync(fp)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

function writeFile(fp, text = "x") {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
}

function isJunction(fp) {
  try {
    const st = fs.lstatSync(fp);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

function skip(name, why) {
  console.log(`  SKIP  ${name}  ${why}`);
}

/**
 * 模拟「并发 helper 把 app 重建出来，并挂了一条 legacy junction」。
 *
 * 1.1.80 起 wscript 会自己把 app/runtime 重建成硬链接树，所以这一步可能撞上真实目录
 * （以前只建 junction，测试因此整批 flaky）。撞上时不做硬来，返回 junction=false，
 * 调用方按「产品已重建 runtime」分支断言，仍然验证不穿链删除与 runtime 完好。
 */
function simulateConcurrentAppRecreation(fx, marker = "recreated") {
  fs.mkdirSync(fx.app, { recursive: true });
  const target = path.join(fx.app, "runtime");
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { junction: true, reason: "already-link" };
    return { junction: false, reason: "product-rebuilt-runtime" };
  } catch {
    /* 不存在，继续建 junction */
  }
  try {
    fs.symlinkSync(fx.runtime, target, "junction");
  } catch (e) {
    return { junction: false, reason: String((e && e.message) || e) };
  }
  writeFile(path.join(fx.app, "recreated-marker.txt"), marker);
  return { junction: true, reason: "created" };
}

/** 建一份与真实安装同构的夹具：resources/app/runtime -> resources/runtime（junction）。 */
function makeFixture(root, { name }) {
  const dir = path.join(root, name);
  const resources = path.join(dir, "resources");
  const runtime = path.join(resources, "runtime");
  const app = path.join(resources, "app");

  fs.mkdirSync(app, { recursive: true });
  for (const rel of OFFICE_SKILLS) writeFile(path.join(runtime, rel), `# ${rel}\n` + "y".repeat(64));
  writeFile(path.join(runtime, "manifest.json"), JSON.stringify({ skills: OFFICE_SKILLS }, null, 2));

  // app/runtime 指向真实 runtime（Windows 用 junction）
  fs.symlinkSync(runtime, path.join(app, "runtime"), "junction");
  writeFile(path.join(app, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.1-rc.1" }));

  const hashes = {};
  for (const rel of OFFICE_SKILLS) hashes[rel] = sha256(path.join(runtime, rel));

  return { dir, resources, runtime, app, hashes };
}

function runtimeIntact(fx) {
  for (const rel of OFFICE_SKILLS) {
    const fp = path.join(fx.runtime, rel);
    if (!fs.existsSync(fp)) return { ok: false, detail: `missing ${rel}` };
    if (sha256(fp) !== fx.hashes[rel]) return { ok: false, detail: `hash drift ${rel}` };
  }
  if (!fs.existsSync(path.join(fx.runtime, "manifest.json"))) return { ok: false, detail: "manifest missing" };
  return { ok: true, detail: "7 skills + manifest intact" };
}

/** 用 cscript 跑一段 FSO 脚本（复现旧行为 / 执行修复后的模板）。 */
function runCscript(scriptPath, cwd) {
  const r = spawnSync("cscript.exe", ["//nologo", scriptPath], {
    cwd,
    stdio: "ignore",
    timeout: 60000,
    windowsHide: true,
  });
  return { status: r.status, error: r.error ? String(r.error.message || r.error) : "" };
}

function readLog(fp) {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

/** 填充 official-update.wscript 的占位符（与生产一致，产物必须是纯 ASCII）。 */
async function renderHandoffScript(fx, { installer, logPath }) {
  const { wshLiteral, isWshAscii } = await import(pathToFileURL(path.join(PLUGIN_ROOT, "lib", "official-update.js")).href);
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "lib", "official-update.wscript"), "utf8");
  const fakeExe = path.join(fx.dir, "fake", "DeepSeek Harness.exe");
  const installDir = path.join(fx.dir, "install");
  fs.mkdirSync(path.join(fx.dir, "fake"), { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  const body = template
    .split("__EXE_JSON__").join(wshLiteral(fakeExe))
    .split("__INSTALLER_JSON__").join(wshLiteral(installer))
    .split("__RESOURCES_JSON__").join(wshLiteral(fx.resources))
    .split("__INSTALL_DIR_JSON__").join(wshLiteral(installDir))
    .split("__LOG_JSON__").join(wshLiteral(logPath));
  if (!isWshAscii(body)) throw new Error("rendered handoff script is not ASCII");
  const out = path.join(fx.dir, "handoff.js");
  fs.writeFileSync(out, body, "utf8");
  return out;
}

/** 假安装器：马上按给定退出码退出。 */
function makeFakeInstaller(fx, exitCode) {
  const fp = path.join(fx.dir, "fake", `installer-${exitCode}.cmd`);
  writeFile(
    fp,
    ["@echo off", "rem fake installer for regression test", `exit /b ${exitCode}`, ""].join("\r\n")
  );
  return fp;
}

/** 慢假安装器：留出「并发 helper 重建 app」的时间窗。 */
function makeSlowFakeInstaller(fx, exitCode) {
  const fp = path.join(fx.dir, "fake", `installer-slow-${exitCode}.cmd`);
  writeFile(
    fp,
    ["@echo off", "rem slow fake installer: ~3s window for concurrent app recreation", "ping -n 4 127.0.0.1 >nul", `exit /b ${exitCode}`, ""].join("\r\n")
  );
  return fp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (child) => new Promise((r) => child.on("exit", (code) => r(code)));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-update-regress-"));
  console.log(`夹具根: ${root}\n`);

  const modHref = pathToFileURL(path.join(PLUGIN_ROOT, "lib", "official-update.js")).href;
  const mod = await import(modHref);

  // ─────────────────────────────────────────────────────────────
  console.log("[1] 普通目录更新成功 / 无 junction");
  {
    const fx = makeFixture(root, { name: "s1-plain" });
    const logPath = path.join(fx.dir, "update.log");
    const script = await renderHandoffScript(fx, { installer: makeFakeInstaller(fx, 0), logPath });
    // 成功路径：先把 app 挪成 prev（wscript 自己会挪），再跑
    runCscript(script, fx.dir);
    const log = readLog(logPath);
    ok("成功路径写出 update-begin / installer 退出码", /update-begin/.test(log) && /installer 0/.test(log), log.split("\n").find((l) => l.includes("installer")) || "");
    const intact = runtimeIntact(fx);
    ok("成功路径 runtime 完好", intact.ok, intact.detail);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[2] 带 app/runtime junction 的更新失败回滚（核心缺陷）");
  {
    const fx = makeFixture(root, { name: "s2-rollback" });
    const logPath = path.join(fx.dir, "update.log");
    // 旧 app 已被事先挪到 prev
    const prev = path.join(fx.resources, "app.dshpurge-prev");
    writeFile(path.join(prev, "old-app-marker.txt"), "old-app");
    // 慢安装器：留出并发重建 app 的时间窗
    const installer = makeSlowFakeInstaller(fx, 1);
    const script = await renderHandoffScript(fx, { installer, logPath });
    const child = spawn("cscript.exe", ["//nologo", script], {
      cwd: fx.dir,
      stdio: "ignore",
      windowsHide: true,
    });
    // wscript 先把自己的 app 挪成 prev-<ts>，随后跑安装器；此时并发 helper 重建 app
    await sleep(1800);
    const recreated = simulateConcurrentAppRecreation(fx, "recreated-by-concurrent-helper");
    if (!recreated.junction) console.log(`  · 并发重建没挂上 junction（${recreated.reason}）`);
    await done(child);

    const log = readLog(logPath);
    const intact = runtimeIntact(fx);
    ok("回滚后真实 runtime 仍在（7 个 Office 文件 + manifest）", intact.ok, intact.detail);
    ok("日志不再出现穿过 junction 的 fso.DeleteFolder 记录", !/cleared-recreated-app/.test(log), "");
    if (recreated.junction) {
      // 1.1.80 起回滚前会先撤掉 legacy junction（dropped-legacy-runtime-link）：这种情况下
      // 不需要「把重建出来的 app 隔离」也是安全的，断言只要求「没有被穿链删掉」。
      ok(
        "重建出来的 app 没有被穿链删除（隔离或先撤链）",
        fs.readdirSync(fx.resources).some((n) => n.startsWith("app.dshpurge-failed-")) ||
          /isolated-app|dropped-legacy-runtime-link/.test(log),
        fs.readdirSync(fx.resources).join(",")
      );
    } else {
      // 产品自己已经把 app/runtime 重建成硬链接树，这条分支里没有「穿链删除」的风险可言，
      // 隔离与否由回滚结果决定，不能拿它当断言。
      skip("重建出来的 app 没有被穿链删除（隔离或先撤链）", `产品已重建 runtime（${recreated.reason}），无 junction 分支`);
    }
    ok("旧 app 已恢复", fs.existsSync(path.join(fx.app, "old-app-marker.txt")), "");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[3] FSO 穿链删除复现（证明缺陷存在，Node rmSync 作对照）");
  {
    const fx = makeFixture(root, { name: "s3-fso-proof" });
    const fsoScript = path.join(fx.dir, "fso-delete.js");
    writeFile(
      fsoScript,
      [
        "var fso = new ActiveXObject('Scripting.FileSystemObject');",
        `var app = ${JSON.stringify(fx.app)};`,
        "if (fso.FolderExists(app)) fso.DeleteFolder(app, true);",
        "",
      ].join("\r\n")
    );
    runCscript(fsoScript, fx.dir);
    const afterFso = runtimeIntact(fx);
    ok("FSO.DeleteFolder 确实穿过 junction 删掉真实 runtime（缺陷已复现）", !afterFso.ok, afterFso.detail);

    // 对照：Node fs.rmSync 只删链接
    const fx2 = makeFixture(root, { name: "s3-node-proof" });
    fs.rmSync(fx2.app, { recursive: true, force: true });
    const afterNode = runtimeIntact(fx2);
    ok("Node fs.rmSync 删除同一结构时保留 runtime", afterNode.ok, afterNode.detail);
    ok("Node 删除后链接本身已不存在", !fs.existsSync(path.join(fx2.app, "runtime")), "");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[4] 成功判定：退出码 / 资源完整性 / 大小不变");
  {
    const fn = typeof mod.updateOutcomeOf === "function" ? mod.updateOutcomeOf : null;
    if (!fn) {
      ok("official-update.js 导出 updateOutcomeOf", false, "尚未实现");
    } else {
      const a = fn({ exitCode: 0, resourcesOk: true, exeSizeChanged: false, asarSizeChanged: false });
      ok("退出码 0 + 资源完整 + 大小不变 => 成功", a.success === true, JSON.stringify(a));
      const b = fn({ exitCode: 1, resourcesOk: true });
      ok("安装器非零退出码 => 失败", b.success === false, JSON.stringify(b));
      const c = fn({ exitCode: 0, resourcesOk: false });
      ok("资源不完整 => 失败", c.success === false, JSON.stringify(c));
      const d = fn({ exitCode: 0, resourcesOk: true, exeSizeChanged: true, asarSizeChanged: false });
      ok("大小变化也照旧判成功（兼容）", d.success === true, JSON.stringify(d));
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[5] 隔离目录清理：合法清理、重复执行、越界与顶层链接拒绝");
  {
    const canClean = typeof mod.isCleanableStaleDir === "function" ? mod.isCleanableStaleDir : null;
    const clear = typeof mod.clearStaleExtractedApps === "function" ? mod.clearStaleExtractedApps : null;
    if (!canClean) {
      ok("official-update.js 导出 isCleanableStaleDir", false, "尚未实现");
    } else {
      const fx = makeFixture(root, { name: "s5-clean" });
      const res = fx.resources;
      const prevDir = path.join(res, "app.dshpurge-prev");
      const failedDir = path.join(res, "app.dshpurge-failed-1700000000000");
      writeFile(path.join(prevDir, "x.txt"), "prev");
      fs.mkdirSync(path.join(failedDir, "app"), { recursive: true });
      // 隔离目录里再放一个指回真实 runtime 的 junction
      fs.symlinkSync(fx.runtime, path.join(failedDir, "app", "runtime"), "junction");

      ok("合法隔离目录可清理", canClean(res, failedDir) === true, "");
      ok("合法 prev 目录可清理", canClean(res, prevDir) === true, "");
      ok("resources 根不可清理", canClean(res, res) === false, "");
      ok("真实 runtime 不可清理", canClean(res, fx.runtime) === false, "");
      ok("真实 app 不可清理", canClean(res, fx.app) === false, "");
      ok("越界目录不可清理", canClean(res, path.join(fx.dir, "elsewhere")) === false, "");

      // 顶层链接：名字合法但本身是 junction -> 拒绝
      const linked = path.join(res, "app.dshpurge-prev-1600000000000");
      fs.symlinkSync(fx.runtime, linked, "junction");
      ok("顶层链接（名字合法但是 junction）被拒绝", canClean(res, linked) === false, isJunction(linked) ? "确认是 junction" : "不是 junction!");

      if (clear) {
        // 用 exe 定位 resources 的入口：这里直接喂 fake exe
        const fakeExe = path.join(fx.dir, "install", "DeepSeek Harness.exe");
        writeFile(fakeExe, "fake");
        // exe 的 dirname/resources 必须就是夹具 resources —— 让 fake exe 落在 resources 的父目录
        const exeInPlace = path.join(fx.dir, "DeepSeek Harness.exe");
        writeFile(exeInPlace, "fake");
        const r1 = clear(exeInPlace);
        ok("清理后隔离目录消失", !fs.existsSync(failedDir), JSON.stringify(r1 || {}));
        ok("清理后 prev 目录消失", !fs.existsSync(prevDir), "");
        ok("清理不碰真实 runtime", runtimeIntact(fx).ok, runtimeIntact(fx).detail);
        ok("顶层链接被保留（拒绝清理）", fs.existsSync(linked) && isJunction(linked), "");
        const r2 = clear(exeInPlace);
        ok("重复执行幂等（第二次无异常）", r2 && r2.ok !== false, JSON.stringify(r2 || {}));
        ok("重复执行后 runtime 仍完好", runtimeIntact(fx).ok, "");
      } else {
        ok("official-update.js 导出 clearStaleExtractedApps", false, "尚未实现");
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[6] 交接日志字段（目标版本 / 退出码 / 校验 / 隔离 / 决定）");
  {
    const fx = makeFixture(root, { name: "s6-log" });
    const logPath = path.join(fx.dir, "update.log");
    writeFile(path.join(fx.resources, "app.dshpurge-prev"), "");
    const script = await renderHandoffScript(fx, { installer: makeFakeInstaller(fx, 1), logPath });
    runCscript(script, fx.dir);
    const log = readLog(logPath);
    ok("日志含 installer 退出码", /installer 1/.test(log), "");
    ok("日志含资源校验结论", /resources/.test(log), log.split("\n").filter((l) => l.includes("resources")).join(" | ").slice(0, 120));
    ok("日志含最终决定", /decide|started-old|started/.test(log), "");
    ok("日志不含凭据字段", !/password|token|secret|api[_-]?key/i.test(log), "");
  }

  console.log("\n[7] app 重命名失败 / 恢复失败时保留现场");
  {
    const fx = makeFixture(root, { name: "s7-stuck" });
    const logPath = path.join(fx.dir, "update.log");
    // 用同名文件顶住 app.dshpurge-prev：MoveFolder(app, prev) 必失败，movedApp=false
    fs.writeFileSync(path.join(fx.resources, "app.dshpurge-prev"), "blocker", "utf8");
    const script = await renderHandoffScript(fx, { installer: makeFakeInstaller(fx, 1), logPath });
    runCscript(script, fx.dir);
    const log = readLog(logPath);
    ok("失败分支记录了 move-app 失败", /move-app/.test(log), log.split("\n").filter((l) => l.includes("move-app")).join(" | ").slice(0, 120));
    ok("失败分支没有乱删东西（runtime 完好）", runtimeIntact(fx).ok, runtimeIntact(fx).detail);
    ok("失败分支保留了可诊断日志", log.length > 0, `${log.length} bytes`);
    ok("失败分支保留了 app 现场", fs.existsSync(path.join(fx.app, "package.json")), "");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[8] app/runtime 用硬链接树，不再建 junction");
  {
    const fx = makeFixture(root, { name: "s8-links" });
    // 夹具默认带 junction（模拟老版本），换成新方案前先撤掉
    fs.rmdirSync(path.join(fx.app, "runtime"));
    const desk = await import(pathToFileURL(path.join(PLUGIN_ROOT, "lib", "desktop.js")).href);
    const r = desk.ensureAppRuntimeLinks(fx.resources);
    const target = path.join(fx.app, "runtime");
    ok("ensureAppRuntimeLinks 返回成功", r.ok === true, JSON.stringify(r));
    ok("app/runtime 是真实目录（不是链接）", !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).isDirectory(), "");
    const srcStat = fs.statSync(path.join(fx.runtime, "office", "SKILL.md"));
    const dstStat = fs.statSync(path.join(target, "office", "SKILL.md"));
    ok(
      "文件是硬链接（nlink>1 且 inode 一致）",
      srcStat.nlink > 1 && (srcStat.ino === dstStat.ino || srcStat.ino === 0),
      `nlink=${srcStat.nlink} ino=${srcStat.ino}/${dstStat.ino}`
    );
    fs.rmSync(fx.app, { recursive: true, force: true });
    const intact = runtimeIntact(fx);
    ok("删掉 app 目录后真实 runtime 完好", intact.ok, intact.detail);
    const again = desk.ensureAppRuntimeLinks(fx.resources);
    ok("app 不存在时返回 missing 而不是抛错", again.ok === false && again.reason === "missing", JSON.stringify(again));
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[9] 带 legacy junction 的安装：更新前先撤链再回滚");
  {
    const fx = makeFixture(root, { name: "s9-legacy" });
    ok("夹具里 app/runtime 是 junction（模拟老版本残留）", isJunction(path.join(fx.app, "runtime")), "");
    const logPath = path.join(fx.dir, "update.log");
    const prev = path.join(fx.resources, "app.dshpurge-prev");
    writeFile(path.join(prev, "old-app-marker.txt"), "old-app");
    const script = await renderHandoffScript(fx, { installer: makeSlowFakeInstaller(fx, 1), logPath });
    const child = spawn("cscript.exe", ["//nologo", script], { cwd: fx.dir, stdio: "ignore", windowsHide: true });
    await sleep(1800);
    const recreated = simulateConcurrentAppRecreation(fx, "recreated");
    await done(child);
    const log = readLog(logPath);
    ok("更新前撤掉了 legacy junction", /dropped-legacy-runtime-link/.test(log), "");
    ok("回滚后 runtime 完好", runtimeIntact(fx).ok, runtimeIntact(fx).detail);
    ok("没有穿过 junction 的递归删除记录", !/cleared-recreated-app/.test(log), "");
    if (!recreated.junction) skip("并发重建的 app 里带 junction", `产品已把 app/runtime 重建成硬链接树（${recreated.reason}）`);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n[10] 占用未解除时不启动安装器（abort-busy，静态断言）");
  {
    const t = fs.readFileSync(path.join(PLUGIN_ROOT, "lib", "official-update.wscript"), "utf8");
    ok("有 occupied() / killAll()", /function occupied\(/.test(t) && /function killAll\(/.test(t), "");
    ok("有 abort-busy 分支", /abort-busy/.test(t), "");
    ok(
      "abort-busy 判断早于安装器调用",
      t.indexOf("abort-busy") > -1 && t.indexOf("abort-busy") < t.indexOf("runInstaller(true)"),
      `abort@${t.indexOf("abort-busy")} install@${t.indexOf("runInstaller(true)")}`
    );
    ok("不再只按 EXE 名枚举进程", !/Name = 'DeepSeek Harness\.exe'/.test(t), "");
    ok("wscript 不再创建 junction", !/symlinkSync/.test(t), "");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log(`PASS ${pass}  FAIL ${fail}`);
  if (fail > 0) console.log("失败项:\n  - " + failures.join("\n  - "));
  console.log(`夹具保留在: ${root}${KEEP ? "" : "（--keep 可保留）"}`);
  if (!KEEP && fail === 0) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试脚本异常:", e && e.stack ? e.stack : e);
  process.exit(2);
});
