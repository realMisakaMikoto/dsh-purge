export const MIN_NODE = "22.13.0";

export function supportedNode(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export function assertRuntime() {
  if (!supportedNode()) throw new Error("dsh-purge requires Node >= " + MIN_NODE + "; running " + process.versions.node);
}

export async function runtimeChecks() {
  const rows = [{ id: "node", ok: supportedNode(), detail: "Node " + process.versions.node + "; required >= " + MIN_NODE }];
  if (!rows[0].ok) return [...rows, { id: "sqlite", ok: false, detail: "Upgrade Node before loading node:sqlite" }];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('ok')");
      if (db.prepare("SELECT value FROM probe").get().value !== "ok") throw new Error("read/write probe failed");
    } finally { db.close(); }
    rows.push({ id: "sqlite", ok: true, detail: "node:sqlite in-memory read/write passed" });
  } catch (error) {
    rows.push({ id: "sqlite", ok: false, detail: String(error.message || error) });
  }
  return rows;
}
