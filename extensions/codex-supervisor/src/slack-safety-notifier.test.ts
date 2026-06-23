import { describe, expect, it, vi } from "vitest";
import { CodexSafetyAuditStore } from "./safety-audit.js";
import {
  formatSlackSafetyAlert,
  SAFETY_SLACK_BOT_TOKEN_ENV,
  SAFETY_SLACK_BOT_TOKEN_FILE_ENV,
  SAFETY_SLACK_CHANNEL_ENV,
  SlackSafetyAuditNotifier,
  slackSafetyNotifierConfigFromEnvironment,
} from "./slack-safety-notifier.js";

function stoppedRecord(store: CodexSafetyAuditStore): string {
  const id = store.begin({
    endpointId: "target",
    threadId: "thread-1",
    turnId: "turn-1",
    reason: "test trigger",
    evidence: "Bearer abcdefghijklmnopqrstuvwxyz and <!channel>",
  });
  store.markStopped(id);
  return id;
}

describe("SlackSafetyAuditNotifier", () => {
  it("posts a redacted alert and records the Slack delivery", async () => {
    const store = new CodexSafetyAuditStore(":memory:");
    const id = stoppedRecord(store);
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, channel: "C0BCD364BKL", ts: "178217.123" }),
    );
    const logs: string[] = [];
    const notifier = new SlackSafetyAuditNotifier(store, {
      botToken: "xoxb-test-token",
      channelId: "C0BCD364BKL",
      fetch,
      log: (message) => logs.push(message),
      now: () => "2026-06-22T12:00:00.000Z",
    });

    await expect(notifier.drainOnce()).resolves.toEqual({ delivered: 1, failed: 0 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });
    if (typeof init?.body !== "string") {
      throw new TypeError("expected Slack request body to be a string");
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      channel: "C0BCD364BKL",
      client_msg_id: id,
      mrkdwn: false,
      metadata: {
        event_type: "openclaw_safety_stop",
        event_payload: { decision_id: id, status: "stopped" },
      },
    });
    expect(body.text).toContain("Bearer [redacted]");
    expect(body.text).toContain("&lt;!channel&gt;");
    expect(body.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(store.get(id)).toMatchObject({
      notificationAttempts: 1,
      notifiedAt: "2026-06-22T12:00:00.000Z",
      slackChannelId: "C0BCD364BKL",
      slackMessageTs: "178217.123",
    });
    expect(logs).toEqual([`OpenClaw safety alert delivered: decision=${id}`]);

    await expect(notifier.drainOnce()).resolves.toEqual({ delivered: 0, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("keeps failed deliveries retryable", async () => {
    const store = new CodexSafetyAuditStore(":memory:");
    const id = stoppedRecord(store);
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: false, error: "not_in_channel" }),
    );
    const notifier = new SlackSafetyAuditNotifier(store, {
      botToken: "xoxb-test-token",
      channelId: "C0BCD364BKL",
      fetch,
      log: () => {},
    });

    await expect(notifier.drainOnce()).resolves.toEqual({ delivered: 0, failed: 1 });
    expect(store.get(id)).toMatchObject({
      notificationAttempts: 1,
      notificationLastError: "Slack chat.postMessage failed: not_in_channel",
    });
    expect(store.get(id)?.notifiedAt).toBeUndefined();

    fetch.mockResolvedValueOnce(Response.json({ ok: true, ts: "178217.456" }));
    await expect(notifier.drainOnce()).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(store.get(id)).toMatchObject({
      notificationAttempts: 2,
      slackMessageTs: "178217.456",
    });
    store.close();
  });
});

describe("slackSafetyNotifierConfigFromEnvironment", () => {
  it("is disabled when no Slack configuration exists", () => {
    expect(slackSafetyNotifierConfigFromEnvironment({})).toBeUndefined();
  });

  it("loads complete inline configuration", () => {
    expect(
      slackSafetyNotifierConfigFromEnvironment({
        [SAFETY_SLACK_BOT_TOKEN_ENV]: " xoxb-test-token ",
        [SAFETY_SLACK_CHANNEL_ENV]: " C0BCD364BKL ",
      }),
    ).toEqual({ botToken: "xoxb-test-token", channelId: "C0BCD364BKL" });
  });

  it("rejects partial or ambiguous configuration", () => {
    expect(() =>
      slackSafetyNotifierConfigFromEnvironment({
        [SAFETY_SLACK_CHANNEL_ENV]: "C0BCD364BKL",
      }),
    ).toThrow("requires");
    expect(() =>
      slackSafetyNotifierConfigFromEnvironment({
        [SAFETY_SLACK_BOT_TOKEN_ENV]: "xoxb-inline",
        [SAFETY_SLACK_BOT_TOKEN_FILE_ENV]: "/secret/token",
        [SAFETY_SLACK_CHANNEL_ENV]: "C0BCD364BKL",
      }),
    ).toThrow("only one");
  });
});

describe("formatSlackSafetyAlert", () => {
  it("makes a failed stop visibly distinct", () => {
    const store = new CodexSafetyAuditStore(":memory:");
    const id = store.begin({
      endpointId: "target",
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "test trigger",
    });
    store.markFailed(id, "turn changed");
    const record = store.get(id);
    expect(record && formatSlackSafetyAlert(record)).toContain("could not interrupt a Codex turn");
    expect(record && formatSlackSafetyAlert(record)).toContain("manual review required");
    store.close();
  });
});
