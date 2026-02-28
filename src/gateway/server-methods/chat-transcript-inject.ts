import { SessionManager } from "@mariozechner/pi-coding-agent";

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

export type GatewayInjectedAbortMeta = {
  aborted: true;
  origin: "rpc" | "stop-command";
  runId: string;
};

export type GatewayInjectedTranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AeonMemoryPlugin: any = null;
// @ts-ignore: Optional dependency for ultra-low-latency memory
import("aeon-memory")
  .then((m) => {
    AeonMemoryPlugin = m.AeonMemory;
  })
  .catch((e: unknown) => {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
      console.error("🚨 [AeonMemory] Load failed:", e);
    }
  });

export function appendInjectedAssistantMessageToTranscript(params: {
  transcriptPath: string;
  message: string;
  label?: string;
  idempotencyKey?: string;
  abortMeta?: GatewayInjectedAbortMeta;
  now?: number;
  sessionId?: string;
}): GatewayInjectedTranscriptAppendResult {
  const now = params.now ?? Date.now();
  const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const messageBody: AppendMessageArg & Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: `${labelPrefix}${params.message}` }],
    timestamp: now,
    // Pi stopReason is a strict enum; this is not model output, but we still store it as a
    // normal assistant message so it participates in the session parentId chain.
    stopReason: "stop",
    usage,
    // Make these explicit so downstream tooling never treats this as model output.
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.abortMeta
      ? {
          openclawAbort: {
            aborted: true,
            origin: params.abortMeta.origin,
            runId: params.abortMeta.runId,
          },
        }
      : {}),
  };

  try {
    // IMPORTANT: Use SessionManager so the entry is attached to the current leaf via parentId.
    // Raw jsonl appends break the parent chain and can hide compaction summaries from context.
    const sessionManager = SessionManager.open(params.transcriptPath);
    let messageId: string;

    if (AeonMemoryPlugin && params.sessionId) {
      const aeon = AeonMemoryPlugin.getInstance();
      if (aeon && aeon.isAvailable()) {
        aeon.saveTurn(params.sessionId, messageBody);
        messageId = `aeon-${params.sessionId}-${now}`;
      } else {
        messageId = sessionManager.appendMessage(messageBody);
      }
    } else {
      messageId = sessionManager.appendMessage(messageBody);
    }

    return { ok: true, messageId, message: messageBody };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
