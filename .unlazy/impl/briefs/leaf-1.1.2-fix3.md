# Fix round 3 for leaf-1.1.2 — restore B9 after another leaf overwrote it

Your B9 file `src/auth/identity.ts` was verified by the driver at 20:11. At 20:23 implementer A
(working on leaf-1.2.1) overwrote it with a 44-line replacement whose `TokenStore` has
`save/load/revokeAll` and which drops `resolveActor`, `matchPlaneUserByEmail`, `encryptSecret`,
`decryptSecret`, `loadTokenKey`, `SecretString`, `loadServiceCredentials` and
`assessServiceAccountRole`. That was A's violation, not yours. Nothing else of yours changed
(the driver compared modification times; the fork patches still pass).

Restore `src/auth/identity.ts` to your last verified version — the content of your final write of
that file in this conversation, including fix rounds 1 and 2 — with the **original** `TokenStore`
contract (`get(planeUserId, kind)`, `put(planeUserId, kind, blob)`, `delete(planeUserId)`).
Do not adapt it to A's version. Then re-run your whole ledger
(`docs/impl/agent-gates/leaf-1.1.2.GATES.md`) with gate-check --approve until ALL MET, and report.
Same OWNS and rules. Do not stage or commit.
