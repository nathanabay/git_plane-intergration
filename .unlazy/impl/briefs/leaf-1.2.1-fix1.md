# Fix round 1 for leaf-1.2.1

1. **Ownership violation.** At 20:23 you overwrote `src/auth/identity.ts`, a file owned and
   already verified by leaf-1.1.2 (implementer B), replacing B9's whole module with a stand-in.
   Never write outside your OWNS — not even temporarily, not to make a test pass. Implementer B
   is restoring that file now. Do not touch `src/auth/**` again.
2. **`src/db/token-store.ts` implements the wrong interface.** `PgTokenStore` must implement B9's
   `TokenStore` exactly as `.unlazy/impl/briefs/leaf-1.2.1.md` and `src/auth/identity.ts` define it:
   `get(planeUserId, kind): Promise<string | null>`, `put(planeUserId, kind, blob): Promise<void>`,
   `delete(planeUserId): Promise<boolean>` (all kinds). `kind` is `TokenKind`
   (`"plane_pat" | "github_oauth"`). Import the type from `../auth/identity.ts`; do not redefine it.
   The A3 oracle uses B9's real `TokenVault` against your store. Until B's restore lands, the
   import may not resolve — wait for it rather than working around it (check with
   `node scripts/verify-identity-contract.mjs`).
3. **`ioredis` is now a declared dependency** (BullMQ 6 takes its Redis client as an optional peer).
   The driver added and committed it; `npm ls ioredis` shows it as a normal dependency.
4. **Driver oracle fixes, for your information.** The A2 oracle leaked a BullMQ queue and hung
   after passing; fixed. The A1 oracle's process probe now boots the service with the full
   environment against a throwaway Postgres 15.7 (rootless Docker) and Valkey, because your A2
   startup rightly refuses to start without configuration. Your G1–G6 should now be able to pass.
5. Your own ledger `docs/impl/agent-gates/leaf-1.2.1.GATES.md` has unmet gates. Finish it: every
   gate met by gate-check --approve, run after your final edit.
