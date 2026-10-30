/**
 * 上游修复回灌的回归：上游 1.1.80–1.1.83 里对得上本 fork 的那几条。
 *
 * 覆盖：
 *  1. #172 lib/skills.js 的 `fs` 导入（否则 #54 软链自删守卫静默失效）
 *  2. #155/#157 原子写保权限（0755 的 dsh 不能被写成 0644）
 *  3. #157 软链启动器：写穿目标、不吃掉软链；已被老版本写成拷贝的能还原软链
 *  4. #188 的 #77 锚点容错：rc.2 形状与旧形状都要命中，二次 apply 不叠加
 *  5. #108 卸载要清 dsh 0.2 的 pkg.dsh.profile.bundles/plugins
 *  6. #170 zip 目录项（含反斜杠）要建目录，不能写成空文件
 *  7. #188 宿主版本门禁（doctor.hostSupport）
 *
 * 只用临时目录里的夹具，不碰真实安装目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import * as core from "../lib/core.js";
import * as doctor from "../lib/doctor.js";
import { stripPluginFromPackage } from "../lib/uninstall.js";
import { extractZipBuffer } from "../lib/zip-extract.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-ports-"));
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass += 1;
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ""}`);
}

function bad(name, e) {
  fail += 1;
  failures.push(`${name}: ${e && e.message ? e.message : e}`);
  console.log(`FAIL  ${name}  ${e && e.message ? e.message : e}`);
}

function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}

function skip(name, why) {
  console.log(`SKIP  ${name}  ${why}`);
}

function dir(...parts) {
  const p = path.join(root, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function write(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

/* ---------------------------------------------------------------- 1. skills fs */

check("#172 lib/skills.js 导入了 fs 本体", () => {
  const src = fs.readFileSync(new URL("../lib/skills.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes('from "node:fs"'));
  assert.ok(line, "找不到 node:fs 的 import");
  assert.match(line, /import\s+fs\s*,/, `默认 fs 未导入：${line.trim()}`);
});

/* --------------------------------------------------------- 2. 原子写保权限 */

if (process.platform === "win32") {
  skip("#155/#157 原子写保留原文件权限", "Windows 无 POSIX 权限位");
} else {
  check("#155/#157 原子写保留原文件权限", () => {
    const fp = write(path.join(dir("mode"), "dsh"), "#!/bin/sh\necho hi\n");
    fs.chmodSync(fp, 0o755);
    core.atomicWriteSync(fp, "#!/bin/sh\necho patched\n");
    assert.equal(fs.statSync(fp).mode & 0o777, 0o755, "同步写把 0755 吃掉了");
  });
  const asyncFp = write(path.join(dir("mode-async"), "dsh"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(asyncFp, 0o755);
  await core.atomicWriteFile(asyncFp, "#!/bin/sh\necho patched\n");
  check("#155/#157 异步原子写保留原文件权限", () => {
    assert.equal(fs.statSync(asyncFp).mode & 0o777, 0o755, "异步写把 0755 吃掉了");
  });
}

/* ------------------------------------------------- 3. 软链启动器（#157） */

function makeNodeLauncher() {
  const base = dir("shim", String(Math.random()).slice(2, 8));
  const pkgDir = dir("shim", path.basename(base), "lib", "node_modules", "@deepseek-ai", "dsh", "lib");
  const bin = write(
    path.join(pkgDir, "bin.js"),
    "#!/usr/bin/env node\nconst boot = require(\"@deepseek-ai/dsh-app-boot\");\nboot.main();\n",
  );
  dir("shim", path.basename(base), "lib", "node_modules", "@deepseek-ai", "dsh-app-boot");
  const binDir = dir("shim", path.basename(base), "bin");
  return { base, bin, binDir };
}

function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

await (async () => {
  const { bin, binDir } = makeNodeLauncher();
  const link = path.join(binDir, "dsh");
  if (!trySymlink(path.join("..", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), link)) {
    skip("#157 软链启动器写穿目标、保住软链", "当前账户不能建符号链接");
  } else {
    const result = await core.patchShim(binDir);
    check("#157 软链启动器写穿目标、保住软链", () => {
      assert.equal(result.dsh, "patched", `patchShim 返回 ${JSON.stringify(result)}`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "软链被 rename 成了普通文件");
      assert.match(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "目标文件没被注入");
    });
    // 还原：备份跟着真实文件走，写回目标，软链仍在
    const reverted = await core.revertShim(binDir, { scrubDesktop: false });
    check("#157 revert 还原目标文件、软链仍在", () => {
      assert.match(String(reverted.dsh || ""), /^reverted/, `revertShim 返回 ${JSON.stringify(reverted)}`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "revert 之后软链没了");
      assert.doesNotMatch(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "注入没被去掉");
    });
  }
})();

await (async () => {
  if (process.platform === "win32") {
    skip("#157 已被写成拷贝的启动器能还原软链", "还原软链只在 POSIX 生效（与上游一致）");
    return;
  }
  const { bin, binDir } = makeNodeLauncher();
  const link = path.join(binDir, "dsh");
  // 模拟老版本留下的现场：软链被替换成一个 bin.js 拷贝
  fs.copyFileSync(bin, link);
  const result = await core.patchShim(binDir);
  check("#157 已被写成拷贝的启动器能还原软链", () => {
    assert.equal(result.dsh, "patched_healed_symlink", `patchShim 返回 ${JSON.stringify(result)}`);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "没有还原成软链");
    assert.match(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "真实入口没被注入");
  });
})();

/* ------------------------------------------------- 4. #77 锚点容错（#188） */

const rewindPatch = core.ALL_PATCHES.find((p) => p.id === 77);
check("#188 #77 补丁存在且用正则锚点", () => {
  assert.ok(rewindPatch, "找不到 #77");
  assert.ok(rewindPatch.replacements[0].pattern instanceof RegExp, "#77 仍在写死整段字面量");
});

const RC2_SHAPE = [
  "\t\t\tappend(record) {",
  "\t\t\t\tconst event = record.event;",
  "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";",
  "\t\t\t\tif (this.revised.size > 0) this.revised.clear();",
  "\t\t\t\tthis.inputs.set(event.seq, record);",
  "\t\t\t}",
  "",
].join("\n");

const LEGACY_SHAPE = [
  "\t\t\tappend(record) {",
  "\t\t\t\tconst event = record.event;",
  "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";",
  "\t\t\t\tthis.revised.clear();",
  "\t\t\t\tthis.inputs.set(event.seq, record);",
  "\t\t\t}",
  "",
].join("\n");

for (const [label, shape, middle] of [
  ["rc.2 形状", RC2_SHAPE, /this\.revised\.size > 0\) this\.revised\.clear\(\);/],
  ["旧形状", LEGACY_SHAPE, /^\t\t\t\tthis\.revised\.clear\(\);$/m],
]) {
  check(`#188 #77 命中${label}`, () => {
    const once = core.applyReplacementsToText(shape, rewindPatch, "conversation-client.js");
    assert.ok(once.changed, "没有命中");
    assert.match(once.text, /isRewindMarker\(event\)/, "注入没写进去");
    assert.match(once.text, middle, "窗口里的官方代码被吃掉了");
    const twice = core.applyReplacementsToText(once.text, rewindPatch, "conversation-client.js");
    assert.equal(twice.changed, false, "二次 apply 又改了（会叠加注入）");
    assert.equal(
      (twice.text.match(/isRewindMarker\(event\)/g) || []).length,
      1,
      "注入被叠加了",
    );
  });
}

/* --------------------------------------------- 5. 卸载清 dsh.profile bundles */

check("#108 卸载清 pkg.dsh.profile.bundles/plugins", () => {
  const pkg = {
    dependencies: { "dsh-purge": "1.1.79", other: "1.0.0" },
    bundles: ["dsh-purge"],
    dsh: { profile: { bundles: ["dsh-purge@1.1.79", "other-bundle"], plugins: [{ id: "dsh-purge" }] } },
  };
  assert.equal(stripPluginFromPackage(pkg), true, "没有报告任何改动");
  assert.deepEqual(pkg.bundles, [], "顶层 bundles 没清");
  assert.deepEqual(pkg.dsh.profile.bundles, ["other-bundle"], "嵌套 bundles 没清干净或误删");
  assert.deepEqual(pkg.dsh.profile.plugins, [], "嵌套 plugins 没清");
  assert.equal(pkg.dependencies.other, "1.0.0", "误删了别人的依赖");
});

/* ------------------------------------------------ 6. zip 目录项（#170） */

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data || "", "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); // method 0 = stored
    local.writeUInt32LE(0, 14); // crc 不校验
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const body = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, centralBuf, eocd]);
}

check("#170 zip 目录项（含反斜杠）建目录而不是空文件", () => {
  const dest = path.join(root, "unzip");
  const zip = makeZip([
    { name: "dir\\", data: "" },
    { name: "dir\\a.txt", data: "hello" },
    { name: "slash/", data: "" },
    { name: "slash/b.txt", data: "world" },
  ]);
  extractZipBuffer(zip, dest);
  assert.ok(fs.statSync(path.join(dest, "dir")).isDirectory(), "反斜杠目录项被写成了文件");
  assert.equal(fs.readFileSync(path.join(dest, "dir", "a.txt"), "utf8"), "hello");
  assert.ok(fs.statSync(path.join(dest, "slash")).isDirectory(), "正斜杠目录项被写成了文件");
  assert.equal(fs.readFileSync(path.join(dest, "slash", "b.txt"), "utf8"), "world");
});

/* ------------------------------------------------- 7. 宿主版本门禁（#188） */

check("#188 宿主版本门禁认得适配与不适配", () => {
  const base = dir("host-ok", "@deepseek-ai");
  write(
    path.join(base, "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: doctor.HOST_TARGET }),
  );
  const okSupport = doctor.hostSupport(base);
  assert.ok(okSupport, "读不到宿主版本");
  assert.equal(okSupport.supported, true, `声明适配的版本被判成不适配：${JSON.stringify(okSupport)}`);

  const bad = dir("host-new", "@deepseek-ai");
  write(path.join(bad, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.9" }));
  const badSupport = doctor.hostSupport(bad);
  assert.equal(badSupport.supported, false, "更新的宿主没有被标成不适配");

  const none = dir("host-missing", "@deepseek-ai");
  assert.equal(doctor.hostSupport(none), null, "读不到版本却给了结论");
});

check("#188 插件自己不会被当宿主", () => {
  const base = dir("host-self", "@deepseek-ai");
  write(path.join(base, "dsh", "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.1.81" }));
  assert.equal(doctor.readHostVersion(base), null);
});

/* --------------------------------------------------------------- 收尾 */

console.log("");
console.log("────────────────────────────────────────");
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) console.log("失败项:\n  - " + failures.join("\n  - "));
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1);
