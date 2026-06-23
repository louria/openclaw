import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SAFETY_AUDIT_DB_ENV = "OPENCLAW_CODEX_SUPERVISOR_AUDIT_DB";

export type CodexSafetyStopAuditInput = {
  endpointId: string;
  threadId: string;
  turnId: string;
  reason: string;
  evidence?: string;
};

export type CodexSafetyStopAuditRecord = CodexSafetyStopAuditInput & {
  id: string;
  createdAt: string;
  status: "pending" | "stopped" | "failed";
  error?: string;
  notifiedAt?: string;
  notificationAttempts: number;
  notificationLastError?: string;
  slackChannelId?: string;
  slackMessageTs?: string;
};

/** Durable safety-stop outbox. Notification delivery is deliberately separate. */
export class CodexSafetyAuditStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS safety_stop_alerts (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'stopped', 'failed')),
        error TEXT,
        notified_at TEXT,
        notification_attempts INTEGER NOT NULL DEFAULT 0,
        notification_last_error TEXT,
        slack_channel_id TEXT,
        slack_message_ts TEXT
      ) STRICT
    `);
    this.ensureColumn("notification_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("notification_last_error", "TEXT");
    this.ensureColumn("slack_channel_id", "TEXT");
    this.ensureColumn("slack_message_ts", "TEXT");
    if (databasePath !== ":memory:") {
      chmodSync(databasePath, 0o600);
    }
  }

  begin(input: CodexSafetyStopAuditInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO safety_stop_alerts
          (id, created_at, endpoint_id, thread_id, turn_id, reason, evidence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        new Date().toISOString(),
        input.endpointId,
        input.threadId,
        input.turnId,
        input.reason,
        input.evidence ?? null,
      );
    return id;
  }

  markStopped(id: string): void {
    this.db.prepare("UPDATE safety_stop_alerts SET status = 'stopped' WHERE id = ?").run(id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE safety_stop_alerts SET status = 'failed', error = ? WHERE id = ?")
      .run(error, id);
  }

  listUnnotified(limit = 100): CodexSafetyStopAuditRecord[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT id, created_at, endpoint_id, thread_id, turn_id, reason, evidence,
                status, error, notified_at, notification_attempts,
                notification_last_error, slack_channel_id, slack_message_ts
         FROM safety_stop_alerts
         WHERE notified_at IS NULL AND status != 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(boundedLimit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  get(id: string): CodexSafetyStopAuditRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, created_at, endpoint_id, thread_id, turn_id, reason, evidence,
                status, error, notified_at, notification_attempts,
                notification_last_error, slack_channel_id, slack_message_ts
         FROM safety_stop_alerts
         WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: Record<string, unknown>): CodexSafetyStopAuditRecord {
    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      endpointId: String(row.endpoint_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      reason: String(row.reason),
      ...(typeof row.evidence === "string" ? { evidence: row.evidence } : {}),
      status: row.status as CodexSafetyStopAuditRecord["status"],
      ...(typeof row.error === "string" ? { error: row.error } : {}),
      ...(typeof row.notified_at === "string" ? { notifiedAt: row.notified_at } : {}),
      notificationAttempts: Number(row.notification_attempts),
      ...(typeof row.notification_last_error === "string"
        ? { notificationLastError: row.notification_last_error }
        : {}),
      ...(typeof row.slack_channel_id === "string" ? { slackChannelId: row.slack_channel_id } : {}),
      ...(typeof row.slack_message_ts === "string" ? { slackMessageTs: row.slack_message_ts } : {}),
    };
  }

  markNotified(
    id: string,
    notifiedAt = new Date().toISOString(),
    delivery?: { channelId: string; messageTs: string },
  ): void {
    this.db
      .prepare(
        `UPDATE safety_stop_alerts
         SET notified_at = ?,
             notification_attempts = notification_attempts + 1,
             notification_last_error = NULL,
             slack_channel_id = ?,
             slack_message_ts = ?
         WHERE id = ? AND notified_at IS NULL`,
      )
      .run(notifiedAt, delivery?.channelId ?? null, delivery?.messageTs ?? null, id);
  }

  markNotificationFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE safety_stop_alerts
         SET notification_attempts = notification_attempts + 1,
             notification_last_error = ?
         WHERE id = ? AND notified_at IS NULL`,
      )
      .run(error, id);
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(safety_stop_alerts)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE safety_stop_alerts ADD COLUMN ${name} ${definition}`);
    }
  }
}
