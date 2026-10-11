import test from "node:test";
import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import type { AppContext } from "../../src/app/context.ts";
import { inboundHandler } from "../../src/app/reducers.ts";
import { deliveryScope } from "../../src/app/writers.ts";
import { nextWriteJobId } from "../../src/operations/outbox.ts";
import type { InboundJob } from "../../src/queue/index.ts";
import { EventRouter } from "../../src/sync/router.ts";

for (const source of ["github", "plane"] as const) {
  test(`F1 ${source} replay write ids use original job metadata, never webhook payload identity`, async () => {
    const attempts: { identity: string; workspaceSlug?: string; ids: string[] }[] = [];
    const router = new EventRouter();
    router.on(source, "identity-test", async () => {
      const scope = deliveryScope.getStore()!;
      attempts.push({ identity: scope.deliveryId, workspaceSlug: scope.workspaceSlug,
        // Equal-content occurrences remain distinct, and reset on each replay attempt.
        ids: ["first", "second", "first"].map((commentHtml) => nextWriteJobId("plane",
          { kind: "add_comment", slug: "ws", projectId: "p", issueId: "i", commentHtml }, scope)),
      });
    });
    // This registered reducer needs no AppContext dependencies or audit database.
    const handler = inboundHandler({} as AppContext, router, source);
    const original: InboundJob = { source, deliveryId: "original", event: "identity-test",
      receivedAt: "2026-10-11T00:00:00Z", payload: { workspace_slug: "ws", writeDeliveryId: "payload-original" } };
    await handler(original);
    await handler({ ...original, deliveryId: "replay", writeDeliveryId: "original",
      payload: { workspace_slug: "ws", writeDeliveryId: "payload-replay" } });
    await handler({ ...original, deliveryId: "replay-of-replay", writeDeliveryId: "original",
      payload: { workspace_slug: "ws", writeDeliveryId: "payload-replay-of-replay" } });
    await handler({ ...original, deliveryId: "independent", payload: { workspace_slug: "ws", writeDeliveryId: "original" } });

    deepStrictEqual(attempts.map((a) => a.identity), [`${source}-original`, `${source}-original`, `${source}-original`, `${source}-independent`]);
    deepStrictEqual(attempts[1]!.ids, attempts[0]!.ids);
    deepStrictEqual(attempts[2]!.ids, attempts[0]!.ids);
    notStrictEqual(attempts[0]!.ids[0], attempts[0]!.ids[2]);
    for (let i = 0; i < 3; i++) notStrictEqual(attempts[3]!.ids[i], attempts[0]!.ids[i]);
    strictEqual(attempts[1]!.workspaceSlug, source === "plane" ? "ws" : undefined);
    strictEqual(deliveryScope.getStore(), undefined);
  });
}
