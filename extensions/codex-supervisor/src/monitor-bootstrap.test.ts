import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapCodexSafetyMonitor } from "./monitor-bootstrap.js";
import type { CodexJsonRpcConnection } from "./types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("bootstrapCodexSafetyMonitor", () => {
  it("creates, records, and starts a fresh monitor thread", async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "codex-monitor-"));
    cleanup.push(root);
    const promptFile = path.join(root, "prompt.md");
    const threadFile = path.join(root, "state", "thread-id");
    await fs.writeFile(promptFile, "monitor safely");
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const connection: CodexJsonRpcConnection = {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "thread-monitor" } };
        }
        if (method === "turn/start") {
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected ${method}`);
      },
      notify: () => undefined,
      close: async () => undefined,
    };

    await expect(
      bootstrapCodexSafetyMonitor(
        {
          url: "ws://127.0.0.1:18790",
          workspace: root,
          threadFile,
          promptFile,
        },
        async () => connection,
      ),
    ).resolves.toEqual({ threadId: "thread-monitor", startedTurn: true });
    await expect(fs.readFile(threadFile, "utf8")).resolves.toBe("thread-monitor\n");
    expect(calls.map((call) => call.method)).toEqual(["thread/start", "turn/start"]);
    expect(calls[0]?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: "monitor safely",
    });
  });

  it("resumes an active saved thread without starting a duplicate turn", async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "codex-monitor-"));
    cleanup.push(root);
    const promptFile = path.join(root, "prompt.md");
    const threadFile = path.join(root, "thread-id");
    await fs.writeFile(promptFile, "monitor safely");
    await fs.writeFile(threadFile, "thread-monitor\n");
    const calls: string[] = [];
    const connection: CodexJsonRpcConnection = {
      request: async (method) => {
        calls.push(method);
        if (method === "thread/resume") {
          return { thread: { id: "thread-monitor" } };
        }
        if (method === "thread/read") {
          return { thread: { id: "thread-monitor", status: { type: "active" } } };
        }
        throw new Error(`unexpected ${method}`);
      },
      notify: () => undefined,
      close: async () => undefined,
    };

    await expect(
      bootstrapCodexSafetyMonitor(
        {
          url: "ws://127.0.0.1:18790",
          workspace: root,
          threadFile,
          promptFile,
        },
        async () => connection,
      ),
    ).resolves.toEqual({ threadId: "thread-monitor", startedTurn: false });
    expect(calls).toEqual(["thread/resume", "thread/read"]);
  });
});
