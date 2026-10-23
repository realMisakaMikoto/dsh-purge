import fs from "node:fs";
import { createRequire } from "node:module";
import { capture, digest, load, save, within } from "./update-transaction.js";

// Installed only in an isolated reapply child, never in the live host.
export function installFileJournal(journal) {
  const tx = load(journal);
  const filesystems = new Set([fs]);
  try { filesystems.add(createRequire(import.meta.url)("original-fs")); } catch { /* Plain Node. */ }
  const restores = [];
  let busy = false;
  const descriptors = new Map();
  const filename = (value) => typeof value === "number" ? descriptors.get(value) : value;
  function before(value) {
    const file = filename(value);
    if (!file || typeof file !== "string" || within(tx.dir, file)) return null;
    const record = capture(tx, file, "host");
    record.pending = true; save(tx);
    return record;
  }
  function after(records) {
    for (const record of records.filter(Boolean)) {
      const info = fs.existsSync(record.path) ? fs.lstatSync(record.path) : null;
      if (info && !info.isFile()) throw new Error("Journal refuses non-file changes");
      record.after = info ? digest(fs.readFileSync(record.path)) : null;
      record.deleted = !info; record.pending = false;
    }
    save(tx);
  }
  for (const disk of filesystems) {
    for (const [method, targets] of Object.entries({
      writeFileSync: [0], appendFileSync: [0], copyFileSync: [1], unlinkSync: [0], rmSync: [0], renameSync: [0, 1],
    })) {
      const original = disk[method];
      if (!original) continue;
      disk[method] = function (...args) {
        if (busy) return original.apply(disk, args);
        busy = true;
        try {
          const records = targets.map((index) => before(args[index]));
          const result = original.apply(disk, args);
          after(records);
          return result;
        } finally { busy = false; }
      };
      restores.push(() => { disk[method] = original; });
    }
    for (const [method, targets] of Object.entries({ writeFile: [0], copyFile: [1], unlink: [0], rm: [0], rename: [0, 1] })) {
      const original = disk.promises[method];
      if (!original) continue;
      disk.promises[method] = async function (...args) {
        // Snapshot synchronously; the reapply implementation awaits each mutation.
        const records = targets.map((index) => before(args[index]));
        const result = await original.apply(disk.promises, args);
        after(records);
        return result;
      };
      restores.push(() => { disk.promises[method] = original; });
    }
    const open = disk.openSync;
    disk.openSync = function (file, flags, ...args) {
      if (busy || !/[wa+]/.test(String(flags))) return open.call(disk, file, flags, ...args);
      busy = true;
      try {
        const record = before(file);
        const fd = open.call(disk, file, flags, ...args);
        descriptors.set(fd, file);
        after([record]);
        return fd;
      } finally { busy = false; }
    };
    restores.push(() => { disk.openSync = open; });
    const write = disk.writeSync;
    disk.writeSync = function (fd, ...args) {
      if (busy) return write.call(disk, fd, ...args);
      busy = true;
      try {
        const record = before(fd);
        const result = write.call(disk, fd, ...args);
        after([record]); return result;
      } finally { busy = false; }
    };
    restores.push(() => { disk.writeSync = write; });
    const close = disk.closeSync;
    disk.closeSync = function (fd) { descriptors.delete(fd); return close.call(disk, fd); };
    restores.push(() => { disk.closeSync = close; });
    const link = disk.symlinkSync;
    disk.symlinkSync = () => { throw new Error("Directory links cannot be created during transactional reapply"); };
    restores.push(() => { disk.symlinkSync = link; });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
