import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectCodexAppServerEndpoint } from "./json-rpc-client.js";
import type { CodexJsonRpcConnection } from "./types.js";

export type CodexSafetyMonitorBootstrapOptions = {
  url: string;
  workspace: string;
  threadFile: string;
  promptFile: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseThreadId(value: unknown): string | undefined {
  const thread = record(record(value)?.thread);
  return typeof thread?.id === "string" ? thread.id : undefined;
}

async function readSavedThreadId(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeSavedThreadId(path: string, threadId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${threadId}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

async function ensureThread(
  connection: CodexJsonRpcConnection,
  opts: CodexSafetyMonitorBootstrapOptions,
  developerInstructions: string,
): Promise<{ threadId: string; created: boolean }> {
  const savedThreadId = await readSavedThreadId(opts.threadFile);
  if (savedThreadId) {
    try {
      const resumed = await connection.request("thread/resume", {
        threadId: savedThreadId,
        persistExtendedHistory: true,
      });
      if (responseThreadId(resumed) === savedThreadId) {
        return { threadId: savedThreadId, created: false };
      }
    } catch {
      // A removed or incompatible stored thread is replaced below.
    }
  }

  const started = await connection.request("thread/start", {
    cwd: opts.workspace,
    personality: "none",
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  });
  const threadId = responseThreadId(started);
  if (!threadId) {
    throw new Error("Codex monitor thread/start returned no thread id");
  }
  await writeSavedThreadId(opts.threadFile, threadId);
  return { threadId, created: true };
}

function threadIsActive(value: unknown): boolean {
  const thread = record(record(value)?.thread);
  const status = record(thread?.status);
  return status?.type === "active" || thread?.status === "active";
}

/** Starts or resumes the one persistent safety-monitor thread. */
export async function bootstrapCodexSafetyMonitor(
  opts: CodexSafetyMonitorBootstrapOptions,
  connect: typeof connectCodexAppServerEndpoint = connectCodexAppServerEndpoint,
): Promise<{ threadId: string; startedTurn: boolean }> {
  const developerInstructions = (await readFile(opts.promptFile, "utf8")).trim();
  if (!developerInstructions) {
    throw new Error("Codex safety monitor prompt must not be empty");
  }
  const connection = await connect({
    id: "safety-monitor",
    transport: "websocket",
    url: opts.url,
  });
  try {
    const ensured = await ensureThread(connection, opts, developerInstructions);
    if (!ensured.created) {
      const read = await connection.request("thread/read", {
        threadId: ensured.threadId,
        includeTurns: true,
      });
      if (threadIsActive(read)) {
        return { threadId: ensured.threadId, startedTurn: false };
      }
    }
    await connection.request("turn/start", {
      threadId: ensured.threadId,
      input: [
        {
          type: "text",
          text: "Begin or resume the continuous OpenClaw Codex safety-monitor loop now.",
          text_elements: [],
        },
      ],
    });
    return { threadId: ensured.threadId, startedTurn: true };
  } finally {
    await connection.close();
  }
}

export function bootstrapOptionsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CodexSafetyMonitorBootstrapOptions {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`${name} must be set`);
    }
    return value;
  };
  return {
    url: required("OPENCLAW_CODEX_MONITOR_URL"),
    workspace: required("OPENCLAW_CODEX_MONITOR_WORKSPACE"),
    threadFile: required("OPENCLAW_CODEX_MONITOR_THREAD_FILE"),
    promptFile: required("OPENCLAW_CODEX_MONITOR_PROMPT_FILE"),
  };
}
