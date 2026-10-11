import type { Db } from "./migrate.ts";
import type { TokenStore, TokenKind } from "../auth/identity.ts";

export class PgTokenStore implements TokenStore {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async put(planeUserId: string, kind: TokenKind, blob: string): Promise<void> {
    await this.db.query(`
      INSERT INTO user_tokens (plane_user_id, kind, ciphertext)
      VALUES ($1, $2, $3)
      ON CONFLICT (plane_user_id, kind) DO UPDATE SET ciphertext = EXCLUDED.ciphertext
    `, [planeUserId, kind, blob]);
  }

  async get(planeUserId: string, kind: TokenKind): Promise<string | null> {
    const res = await this.db.query(`SELECT ciphertext FROM user_tokens WHERE plane_user_id = $1 AND kind = $2`, [planeUserId, kind]);
    if (res.rows.length === 0) return null;
    return res.rows[0].ciphertext;
  }

  async delete(planeUserId: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM user_tokens WHERE plane_user_id = $1 RETURNING 1`, [planeUserId]);
    return res.rows.length > 0;
  }
}
