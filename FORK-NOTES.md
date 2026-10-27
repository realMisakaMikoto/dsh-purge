# FORK NOTES — 跑在 DSH 0.2.1-rc.3 / 0.2.1-rc.2 / 0.2.1-rc.1 / 0.2.0-rc.2 上的可用副本

上游：<https://github.com/YuJunZhiXue/dsh-purge>（MIT，见 `LICENSE`）
本仓库版本：`dsh-purge 1.1.71`，针对 **DSH 0.2.1-rc.3 / 0.2.1-rc.2 / 0.2.1-rc.1 / 0.2.0-rc.2（desktop / `resources/app`）** 打了四组修复。
不是上游的发布分支，也不带任何本机数据（`$DSH_HOME/redteam/config.json`、密钥、engagement 记录都不在仓库里）。

## 修复 1 — `#40 COMPLETE_PROMPT_KEEP_INJECT` 命中不到 rc.2 的 complete 收尾块

rc.2 的 `SystemPrompt.assemble()` 在收尾块前多插了一行 `const requiredContexts = new Set(...)`，
`contexts` 分支也从 `[]` 变成 `filter(required)`。原来 7 个 pattern 全部 `matchesPattern=false`
→ `patchStatus` 返回 **`skipped`（不是 `pending`）** → `ensureHostClean()` 的 `needsApply` 直接跳过 apply
→ 标记 `[dsh-purge] complete prompt keeps waterfall inject` 永远写不上
→ `hostPromptKeepsInject()` 恒 false → `allPatchHostsWritten()` 恒 false
→ 重启门禁永久输出「清洗没有写进全部宿主，已取消重启」。

修法（`lib/core.js`）：

- 新增 `COMPLETE_PROMPT_WATERFALL_INJECT_02`，精确匹配 rc.2 的 `requiredContexts` 形状，保留原语义
  （`purge 段 + rest 尾 + complete 收尾`，`requiredContexts` 过滤逻辑原样保留）；
- 末尾追加**兜底 pattern**：任何未来形状只要还留着
  `sections: completeSection === void 0 ? transformed.sections : [completeSection],`
  就就地改成保留 dsh-purge inject 段 —— 这类「官方改形 → skipped → 永久取消重启」不会再复现；
- 两条都幂等（已 apply 的文件再跑 `applyReplacementsToText` 不再变化）。

## 修复 2 — `hostFs` 缺 `closeSync` / `readSync`（静默失效，不抛错）

`core.js` 里 `const fs = hostFs`，而 `lib/extract-asar.js` 的 `HOST_SYNC` 只有 `openSync`：

- `backupAll()` 的 `fs.closeSync(placeholderFd)` 抛 `TypeError`（被 `try/catch` 吞）→ 占位 fd 泄漏
  → 目标文件一直被本进程占着 → `rename(tmp, *.dshpurge.bak)` 每个文件 `EPERM`
  → 全量备份 **0 条**、`hasBackup()` 恒 false、`revert` 没有原件可回；
- `isTextShim()` 的 `fs.readSync` 每次抛错 → 一律判「非文本 shim」→ `dsh.ps1` / `dsh` 永不注入。

修法：`HOST_SYNC` 补 `closeSync / readSync / writeSync / fsyncSync / fstatSync / accessSync`。

## 修复 3 — 红队 preset 在 rc.2 注册即 broken（模式"消失"）

rc.2 的 `dsh-tool-subagent` 在 `apply()` 里硬弃用两个 config 键：

```js
for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field))
  throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins
  in an Agent Preset and select it with agentPreset (spawn only)`);
```

`presets/redteam/agent.cordis.yml` 的 `tool-subagent` 行还带着 `toolFilter.deny: [subagent_fork, workflow, ralph]`
→ `ctx.agentPresets.register()` 后 `phase: registered-broken`
→ 模式下拉过滤掉 broken preset → registry 回落 `standard` → `isRedteamSession()` false
→ 红队人格 / 角色段 / skills 全不挂（日志 `redteam=false`）。

修法：删掉 `toolFilter` 块，保留 `maxDepth: 1`（把递归预算收死）。
要把子会话的工具目录也收紧，0.2 的正解是另建一个不含 delegation 组的 leaf preset，
在该行写 `agentPreset: <leaf>`（只有 spawn provider 支持独立选 preset）。

## 回归测试

```bash
node scripts/check-40-and-hostfs.mjs
```

覆盖：`#40` rc.2 形状命中、标记写入、`requiredContexts` 语义保留、幂等、未知新形状走兜底、
`hostFs` 同步方法完整性、备份 `rename` 不再 `EPERM`。当前 18 项全 PASS。

## 与上游的差异面

```
lib/core.js                                            # 修复 1 + 诊断增强（promptDropReport / hostsUnwritten）
lib/extract-asar.js                                    # 修复 2 + 隔离目录清理校验
lib/official-update.wscript                            # 修复 4（更新交接回滚）
lib/official-update.js                                 # 修复 4（成功判定 / 路径校验 / 安全清理）
lib/index.js                                           # 启动时清理报告写日志
presets/redteam/agent.cordis.yml                        # 修复 3
scripts/check-40-and-hostfs.mjs                        # 回归测试 1
scripts/test-official-update-rollback.mjs              # 回归测试 2（更新交接 / 回滚）
```

`promptDropReport(aiBase)` 是新增的诊断导出：逐项返回 `identityMarked / injectMarked / identityLeft /
dropsInject / isPromptModule` 和 `reason`，门禁失败时会连宿主路径、`#40` 状态一起返回，
不再只丢一句「没写进全部宿主」。

---

## 修复 4 — 更新交接失败回滚会穿过 junction 删掉真实 runtime

**缺陷（已复现）**：`lib/official-update.wscript` 的失败回滚分支里有

```js
fso.DeleteFolder(appDir, true);   // appDir = resources\app
```

WSH 的 `FileSystemObject.DeleteFolder` 递归删除会**穿过目录链接**。官方桌面安装把
`resources\app\runtime` 做成指向 `resources\runtime` 的 junction，于是这一删把真实 runtime
的内容一起抹掉，只留下空目录 —— 表现就是 office/SKILL.md 等运行资源丢失。
同一结构交给 Node 的 `fs.rmSync` 时只删链接本身，目标不受影响（两种行为都有回归用例固定）。

**修法**

1. `official-update.wscript`：回滚时不再删除重建出来的 `resources\app`，改为改名隔离到
   `app.dshpurge-failed-<ts>`；改名失败就记日志并保留现场，绝不递归删除。
   恢复旧 app 时优先用规范名 `app.dshpurge-prev`（升级前那一份），避免把并发 helper 重建的
   目录当成旧版本恢复。
2. `official-update.js`：新增 `isCleanableStaleDir()`，只允许清理「resources 的直接子项 + 名字匹配
   `app.dshpurge-(prev|failed)(-<ts>)?` + 本身不是链接」的目录；`clearStaleExtractedApps()` 改为
   `fs.rmSync` 并返回 `{removed, rejected, errors}`，被拒绝的条目原样保留。
3. `extract-asar.js`：`restoreExtractedDir()` 清隔离目录前复核同级路径、目录名与链接属性。
4. 成功判定：不再用「EXE/ASAR 大小或时间戳变了」当成功依据（安装器可能产出字节相同的文件，
   旧规则会因此触发第二次安装 + 假回滚）。现在只认「安装器退出码 0 + 必需资源存在」，
   大小变化仅作诊断字段；非零退出码不重试。
5. 交接日志新增 `decide` / `decide-final` / `isolated-app` / `restore-app-skipped` 等记录，
   含退出码、资源校验结论、隔离与恢复路径、最终决定；不写凭据或对话内容。

**回归**：`node scripts/test-official-update-rollback.mjs` — 34 项，7 个场景（正常更新、junction 回滚、
FSO 穿链复现与 Node 对照、大小不变判成功、非零退出码/资源不完整、隔离清理与重复执行、越界与顶层
链接拒绝、重命名失败保留现场），全部 PASS。全部夹具在临时目录内，fake exe / fake installer，
不碰真实安装目录。

## Community updater and target selection

- Version checks, package downloads, installed profile specs, and Git updates use `realMisakaMikoto/dsh-purge`. Git updates fetch the requested ref directly from this repository and retain the checkout's existing origin.
- Geographic and bank-domain target gates, the own-server exception list UI, and its API are removed. Existing allowlist files are not modified.
- The Windows update rollback and runtime/junction protections remain unchanged.

Validation: `node scripts/check-community-update.mjs` exercises version metadata, Git updates with a different origin, pinned tags, archive installs, and profile dependency URLs using temporary local repositories and mocked HTTP responses.

## Selected upstream evidence and rewind features

Source: YuJunZhiXue/dsh-purge 1.1.74, commit `5a9b8e14856138814a2139a0105481e1dcdaece4`.

- Import the evidence ledger, eight evidence/unknown tools, and the corresponding preset instructions.
- Import the upstream rewind implementation: step/turn boundaries, new-session fork/create, source archival, and cancellation/archive of the selected turn's subagents. Add the conversation client dependency required to select the new session.
- Keep this community build's updater, target-gate removal, knowledge base, bundled skills, and Windows rollback protections.
- Preserve upstream attribution in `NOTICE` and `docs/upstream-dsh-purge-LICENSE`; the existing project license metadata is unchanged.

Validation: `node scripts/check-evidence-rewind.mjs` covers ten evidence/rewind groups with in-memory SQLite and a fixture session controller. Community update checks also verify preset and NOTICE delivery in archive installs.

## Desktop activation verification (1.1.74)

A patched resources/app directory is not proof that the running desktop has switched away from app.asar. Status now exposes patches_active and activation_pending; the UI keeps the warning visible for a located extraction. Sealed hosts cannot be accepted by hostCleanEnoughToKeep. Apply replies report restart_required without claiming an unstarted restart or swap.

Regression: node scripts/check-desktop-activation.mjs (temporary files only; no live installation writes).

## Multi-host CLI status and doctor

The original multi-host status and doctor implementation was contributed by [@Heaven-Heart](https://github.com/Heaven-Heart) in [PR #1](https://github.com/realMisakaMikoto/dsh-purge/pull/1). Both original authored commits are retained when merging this contribution.

Maintainer follow-up connects doctor to the CLI, validates health/exit codes and baseline writes, propagates the selected surface through all status checks, respects explicit selection, identifies only running installations, and handles copied/missing installations and relative symlinks. The 1.1.74 activation verification and prior runtime fixes remain in place.

Regression: `node scripts/check-status-doctor.mjs` (temporary host and CLI fixtures); the Release checks run it alongside the desktop activation regression.
