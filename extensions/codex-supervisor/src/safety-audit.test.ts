import { describe, expect, it } from "vitest";
import { CodexSafetyAuditStore } from "./safety-audit.js";

describe("CodexSafetyAuditStore", () => {
  it("keeps failed and successful stops in the durable notification outbox", () => {
    const store = new CodexSafetyAuditStore(":memory:");
    const pendingId = store.begin({
      endpointId: "target",
      threadId: "thread-pending",
      turnId: "turn-pending",
      reason: "still stopping",
    });
    const failedId = store.begin({
      endpointId: "target",
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "unsafe action",
    });
    store.markFailed(failedId, "stale turn");
    const stoppedId = store.begin({
      endpointId: "target",
      threadId: "thread-2",
      turnId: "turn-2",
      reason: "test trigger",
      evidence: "test evidence",
    });
    store.markStopped(stoppedId);

    expect(store.listUnnotified()).toEqual([
      expect.objectContaining({
        id: failedId,
        status: "failed",
        error: "stale turn",
      }),
      expect.objectContaining({
        id: stoppedId,
        status: "stopped",
        evidence: "test evidence",
      }),
    ]);
    expect(store.get(pendingId)).toMatchObject({ status: "pending" });
    store.markNotified(stoppedId, "2026-06-22T00:00:00.000Z");
    expect(store.listUnnotified()).toEqual([
      expect.objectContaining({ id: failedId, status: "failed" }),
    ]);
    expect(store.get(stoppedId)).toMatchObject({
      notificationAttempts: 1,
      notifiedAt: "2026-06-22T00:00:00.000Z",
    });
    store.markNotificationFailed(failedId, "Slack unavailable");
    expect(store.get(failedId)).toMatchObject({
      notificationAttempts: 1,
      notificationLastError: "Slack unavailable",
    });
    store.close();
  });
});
