import { readFileSync } from "node:fs";
import { redactCodexSupervisorValue } from "./mcp-tools.js";
import type { CodexSafetyAuditStore, CodexSafetyStopAuditRecord } from "./safety-audit.js";

export const SAFETY_SLACK_BOT_TOKEN_ENV = "OPENCLAW_CODEX_SUPERVISOR_SLACK_BOT_TOKEN";
export const SAFETY_SLACK_BOT_TOKEN_FILE_ENV = "OPENCLAW_CODEX_SUPERVISOR_SLACK_BOT_TOKEN_FILE";
export const SAFETY_SLACK_CHANNEL_ENV = "OPENCLAW_CODEX_SUPERVISOR_SLACK_CHANNEL_ID";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export type SlackSafetyNotifierConfig = {
  botToken: string;
  channelId: string;
};

export type SlackSafetyNotifierOptions = SlackSafetyNotifierConfig & {
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  now?: () => string;
};

export type SlackSafetyNotifierDrainResult = {
  delivered: number;
  failed: number;
};

function requiredChannelId(value: string): string {
  const channelId = value.trim();
  if (!/^[CG][A-Z0-9]{8,}$/.test(channelId)) {
    throw new Error(`${SAFETY_SLACK_CHANNEL_ENV} must be a Slack channel or group ID`);
  }
  return channelId;
}

function tokenFromEnvironment(env: NodeJS.ProcessEnv): string {
  const inlineToken = env[SAFETY_SLACK_BOT_TOKEN_ENV]?.trim();
  const tokenFile = env[SAFETY_SLACK_BOT_TOKEN_FILE_ENV]?.trim();
  if (inlineToken && tokenFile) {
    throw new Error(
      `configure only one of ${SAFETY_SLACK_BOT_TOKEN_ENV} or ${SAFETY_SLACK_BOT_TOKEN_FILE_ENV}`,
    );
  }
  const token = inlineToken ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : "");
  if (!token) {
    throw new Error("Slack safety notification token is empty");
  }
  return token;
}

/** Returns no config when notification is disabled and rejects partial config. */
export function slackSafetyNotifierConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SlackSafetyNotifierConfig | undefined {
  const hasToken = Boolean(
    env[SAFETY_SLACK_BOT_TOKEN_ENV]?.trim() || env[SAFETY_SLACK_BOT_TOKEN_FILE_ENV]?.trim(),
  );
  const hasChannel = Boolean(env[SAFETY_SLACK_CHANNEL_ENV]?.trim());
  if (!hasToken && !hasChannel) {
    return undefined;
  }
  if (!hasToken || !hasChannel) {
    throw new Error(
      `Slack safety notification requires ${SAFETY_SLACK_CHANNEL_ENV} and one bot-token source`,
    );
  }
  return {
    botToken: tokenFromEnvironment(env),
    channelId: requiredChannelId(env[SAFETY_SLACK_CHANNEL_ENV] ?? ""),
  };
}

function safeText(value: string, maxLength: number): string {
  return String(redactCodexSupervisorValue(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .slice(0, maxLength);
}

/** Renders only redacted plain text; transcript content cannot create Slack mentions. */
export function formatSlackSafetyAlert(record: CodexSafetyStopAuditRecord): string {
  const stopped = record.status === "stopped";
  const lines = [
    stopped
      ? "OpenClaw safety monitor interrupted a Codex turn"
      : "OpenClaw safety monitor could not interrupt a Codex turn",
    "",
    `Decision: ${record.id}`,
    `Endpoint: ${safeText(record.endpointId, 200)}`,
    `Thread: ${safeText(record.threadId, 200)}`,
    `Turn: ${safeText(record.turnId, 200)}`,
    `Reason: ${safeText(record.reason, 500)}`,
  ];
  if (record.evidence) {
    lines.push(`Evidence: ${safeText(record.evidence, 2_000)}`);
  }
  if (record.error) {
    lines.push(`Stop error: ${safeText(record.error, 2_000)}`);
  }
  lines.push(
    `Action: ${stopped ? "turn and background processes stopped" : "manual review required"}`,
  );
  return lines.join("\n").slice(0, 3_900);
}

/** Durable outbox worker. A failed Slack call leaves the record retryable. */
export class SlackSafetyAuditNotifier {
  private readonly fetch: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => string;
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<SlackSafetyNotifierDrainResult>;

  constructor(
    private readonly store: CodexSafetyAuditStore,
    private readonly options: SlackSafetyNotifierOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.now = options.now ?? (() => new Date().toISOString());
    requiredChannelId(options.channelId);
    if (!options.botToken.trim()) {
      throw new Error("Slack safety notification token is empty");
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.drainOnce();
    this.timer = setInterval(() => void this.drainOnce(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.draining;
  }

  drainOnce(): Promise<SlackSafetyNotifierDrainResult> {
    if (this.draining) {
      return this.draining;
    }
    const run = this.drainOutbox().finally(() => {
      if (this.draining === run) {
        this.draining = undefined;
      }
    });
    this.draining = run;
    return run;
  }

  private async drainOutbox(): Promise<SlackSafetyNotifierDrainResult> {
    const result = { delivered: 0, failed: 0 };
    for (const record of this.store.listUnnotified()) {
      try {
        const messageTs = await this.post(record);
        this.store.markNotified(record.id, this.now(), {
          channelId: this.options.channelId,
          messageTs,
        });
        result.delivered += 1;
        this.log(`OpenClaw safety alert delivered: decision=${record.id}`);
      } catch (error) {
        const message = safeText(error instanceof Error ? error.message : String(error), 2_000);
        this.store.markNotificationFailed(record.id, message);
        result.failed += 1;
        this.log(`OpenClaw safety alert delivery failed: decision=${record.id} error=${message}`);
      }
    }
    return result;
  }

  private async post(record: CodexSafetyStopAuditRecord): Promise<string> {
    const response = await this.fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.botToken.trim()}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: this.options.channelId,
        text: formatSlackSafetyAlert(record),
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
        client_msg_id: record.id,
        metadata: {
          event_type: "openclaw_safety_stop",
          event_payload: { decision_id: record.id, status: record.status },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Slack chat.postMessage HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      ts?: string;
    };
    if (!payload.ok || !payload.ts) {
      throw new Error(
        `Slack chat.postMessage failed: ${payload.error ?? "missing message timestamp"}`,
      );
    }
    return payload.ts;
  }
}
