import { after, afterEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../src/db/migrate.ts";
import { TriageWriteRejected } from "../../src/sync/plane.ts";
import type { PlaneWrite, PlaneWriteResult } from "../../src/sync/plane.ts";
import type { SecretString } from "../../src/auth/identity.ts";

const opened: PGlite[] = [];
// PGlite keeps the process alive and holds ~100 MB of WASM memory outside the V8 heap (so --max-old-space-size
// does not bound it): close each test's databases as soon as the test ends, not when the file finishes.
async function closeOpened(): Promise<void> { await Promise.all(opened.splice(0).map((d) => d.close().catch(() => undefined))); }
afterEach(closeOpened);
after(closeOpened);

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  opened.push(db);
  await db.waitReady;
  await migrate(db);
  return db;
}

export const QLL = [
  { id: "s-backlog", name: "Backlog", group: "backlog" }, { id: "s-todo", name: "To Do", group: "unstarted" },
  { id: "s-prog", name: "In Progress", group: "started" }, { id: "s-review", name: "In Review", group: "started" },
  { id: "s-done", name: "Done", group: "completed" }, { id: "s-wont", name: "Won't Do", group: "cancelled" },
  { id: "s-triage", name: "Triage", group: "triage" },
];

export type RecordedPlaneWrite = PlaneWrite & { token: string };

/** Records every write and imitates A4's triage ban; ids are `id-<n>` and links `link-<n>`. */
export function fakePlaneWriter(opts: { failOn?: (w: PlaneWrite) => Error | null } = {}) {
  const writes: RecordedPlaneWrite[] = [];
  return {
    writes,
    apply: async (w: PlaneWrite, o?: { actorToken?: SecretString }): Promise<PlaneWriteResult> => {
      const err = opts.failOn?.(w);
      if (err) throw err;
      writes.push({ ...w, token: o?.actorToken ? o.actorToken.reveal() : "SERVICE" });
      if (w.kind === "update_issue" && w.fields.state === "s-triage") throw new TriageWriteRejected();
      return { ok: true, id: w.kind === "add_link" ? `link-${writes.length}` : `id-${writes.length}` };
    },
  };
}

export function fakeGithubWriter() {
  const writes: any[] = [];
  return {
    writes,
    apply: async (w: any) => {
      writes.push(w);
      return { ok: true as const, id: writes.length, number: w.kind === "create_issue" ? 900 + writes.length : undefined };
    },
  };
}
