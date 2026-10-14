// Installer: creates git-sync's own role and database on Plane's Postgres, as Plane's superuser. Safe to repeat:
// an existing role gets the password from git-sync.env, so the file and the database always agree.
import pg from "pg";

export interface SuperuserConnection { host: string; port: number; user: string; password: string }

export async function ensureDatabase(su: SuperuserConnection, password: string, connect = (c: pg.ClientConfig) => new pg.Client(c)): Promise<{ createdRole: boolean; createdDatabase: boolean }> {
  const client = connect({ host: su.host, port: su.port, user: su.user, password: su.password, database: "postgres", connectionTimeoutMillis: 10_000 });
  client.on("error", () => {});
  await client.connect();
  try {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'gitsync'");
    // Identifiers are fixed; the password is quoted by Postgres itself (quote_literal), never spliced in raw.
    const literal = (await client.query<{ q: string }>("SELECT quote_literal($1) AS q", [password])).rows[0]?.q;
    if (!literal) throw new Error("could not quote the database password");
    if (role.rowCount) await client.query(`ALTER ROLE gitsync WITH LOGIN PASSWORD ${literal}`);
    else await client.query(`CREATE ROLE gitsync WITH LOGIN PASSWORD ${literal}`);
    const db = await client.query("SELECT 1 FROM pg_database WHERE datname = 'gitsync'");
    if (!db.rowCount) await client.query("CREATE DATABASE gitsync OWNER gitsync");
    return { createdRole: !role.rowCount, createdDatabase: !db.rowCount };
  } finally {
    await client.end().catch(() => {});
  }
}

/** --uninstall --purge: drops git-sync's database and role. Plane's own data is never touched. */
export async function dropDatabase(su: SuperuserConnection, connect = (c: pg.ClientConfig) => new pg.Client(c)): Promise<void> {
  const client = connect({ host: su.host, port: su.port, user: su.user, password: su.password, database: "postgres", connectionTimeoutMillis: 10_000 });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("DROP DATABASE IF EXISTS gitsync WITH (FORCE)");
    await client.query("DROP ROLE IF EXISTS gitsync");
  } finally {
    await client.end().catch(() => {});
  }
}
