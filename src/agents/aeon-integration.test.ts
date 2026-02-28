/**
 * Integration tests for the optional aeon-memory plugin.
 *
 * Proves two critical invariants for upstream maintainers:
 *   A) When aeon-memory is NOT installed / fails to load, OpenClaw falls back
 *      to legacy JSONL persistence without crashing.
 *   B) When aeon-memory IS installed and available, write hooks bypass the
 *      legacy path and delegate to Aeon's WAL via `saveTurn()`.
 *   C) When aeon-memory IS installed but the instance is unavailable,
 *      writes degrade gracefully to the legacy path.
 *   D) The `readSessionMessages` read path similarly falls back to JSONL
 *      when Aeon has no data for a given session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Shared mock state ──────────────────────────────────────────────
// These are "hoisted" so they exist BEFORE vi.mock factory runs.
const mockSaveTurn = vi.fn();
const mockGetTranscript = vi.fn().mockReturnValue([]);
const mockIsAvailable = vi.fn().mockReturnValue(false);
const mockGetInstance = vi.fn().mockReturnValue(null);

// ─── Test A & C: installSessionToolResultGuard ──────────────────────
//
// The guard module uses a top-level dynamic import("aeon-memory") to cache
// AeonMemoryPlugin. By controlling the vi.mock factory we can toggle between:
//   • null (simulating package absent)
//   • a fake class (simulating package present & available)
//   • a fake class with isAvailable() → false (simulating degradation)

describe("aeon-memory integration — installSessionToolResultGuard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockSaveTurn.mockClear();
    mockGetTranscript.mockClear();
    mockIsAvailable.mockClear().mockReturnValue(false);
    mockGetInstance.mockClear().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test A: Fallback mode — aeon-memory is NOT installed ──────────
  describe("fallback mode (plugin absent)", () => {
    beforeEach(() => {
      // Mock aeon-memory to throw on import → AeonMemoryPlugin stays null
      vi.doMock("aeon-memory", () => {
        throw new Error("MODULE_NOT_FOUND");
      });
    });

    it("persists messages via legacy SessionManager.appendMessage without errors", async () => {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      const { installSessionToolResultGuard } = await import("./session-tool-result-guard.js");

      const sm = SessionManager.inMemory();
      const originalAppend = vi.spyOn(sm, "appendMessage");

      installSessionToolResultGuard(sm);

      // Append an assistant message with a tool call
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      } as Parameters<typeof sm.appendMessage>[0]);

      // Append the matching tool result
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents here" }],
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof sm.appendMessage>[0]);

      // Both messages should have been persisted via the legacy path
      const entries = sm.getEntries().filter((e) => e.type === "message");
      expect(entries).toHaveLength(2);
      const roles = entries.map((e) => (e as { message: { role: string } }).message.role);
      expect(roles).toEqual(["assistant", "toolResult"]);

      // The original appendMessage must have been called (not Aeon)
      expect(originalAppend).toHaveBeenCalled();
    });

    it("flushes pending synthetic tool results via legacy path", async () => {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      const { installSessionToolResultGuard } = await import("./session-tool-result-guard.js");

      const sm = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(sm);

      // Append a tool call, then flush without providing a result
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "write", arguments: {} }],
      } as Parameters<typeof sm.appendMessage>[0]);

      guard.flushPendingToolResults();

      // Should have assistant + synthetic toolResult, both via legacy
      const entries = sm.getEntries().filter((e) => e.type === "message");
      expect(entries).toHaveLength(2);
      const roles = entries.map((e) => (e as { message: { role: string } }).message.role);
      expect(roles).toEqual(["assistant", "toolResult"]);
    });
  });

  // ── Test B: Active bypass mode — aeon-memory IS installed & available ──
  describe("active bypass mode (plugin loaded + available)", () => {
    beforeEach(() => {
      const fakeInstance = {
        isAvailable: () => true,
        saveTurn: mockSaveTurn,
        getTranscript: mockGetTranscript,
      };
      mockGetInstance.mockReturnValue(fakeInstance);

      vi.doMock("aeon-memory", () => ({
        AeonMemory: {
          getInstance: mockGetInstance,
        },
      }));
    });

    it("delegates writes to aeon.saveTurn() instead of legacy appendMessage", async () => {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      const { installSessionToolResultGuard } = await import("./session-tool-result-guard.js");

      const sm = SessionManager.inMemory();

      // Spy BEFORE the guard patches appendMessage
      const _originalEntries = () => sm.getEntries().filter((e) => e.type === "message");

      installSessionToolResultGuard(sm);

      // Wait for the dynamic import() to resolve inside the module
      await new Promise((r) => setTimeout(r, 50));

      // Append an assistant message (non-tool-call)
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Hello from Aeon" }],
        stopReason: "stop",
      } as Parameters<typeof sm.appendMessage>[0]);

      // saveTurn should have been called instead of legacy append
      expect(mockSaveTurn).toHaveBeenCalledTimes(1);
      expect(mockSaveTurn.mock.calls[0][1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello from Aeon" }],
      });
    });

    it("delegates toolResult writes to aeon.saveTurn()", async () => {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      const { installSessionToolResultGuard } = await import("./session-tool-result-guard.js");

      const sm = SessionManager.inMemory();
      installSessionToolResultGuard(sm);

      await new Promise((r) => setTimeout(r, 50));

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_a", name: "read", arguments: {} }],
      } as Parameters<typeof sm.appendMessage>[0]);

      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_a",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
      } as Parameters<typeof sm.appendMessage>[0]);

      // Both the assistant and toolResult should have gone through saveTurn
      expect(mockSaveTurn).toHaveBeenCalledTimes(2);
    });
  });

  // ── Test C: Graceful degradation — plugin loaded but unavailable ──
  describe("graceful degradation (plugin loaded, instance unavailable)", () => {
    beforeEach(() => {
      // AeonMemory class exists, but getInstance returns an unavailable instance
      mockGetInstance.mockReturnValue({
        isAvailable: () => false,
        saveTurn: mockSaveTurn,
        getTranscript: mockGetTranscript,
      });

      vi.doMock("aeon-memory", () => ({
        AeonMemory: {
          getInstance: mockGetInstance,
        },
      }));
    });

    it("falls back to legacy persistence when aeon instance is unavailable", async () => {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      const { installSessionToolResultGuard } = await import("./session-tool-result-guard.js");

      const sm = SessionManager.inMemory();
      installSessionToolResultGuard(sm);

      await new Promise((r) => setTimeout(r, 50));

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Degraded gracefully" }],
        stopReason: "stop",
      } as Parameters<typeof sm.appendMessage>[0]);

      // saveTurn should NOT have been called
      expect(mockSaveTurn).not.toHaveBeenCalled();

      // Legacy path should have persisted the message
      const entries = sm.getEntries().filter((e) => e.type === "message");
      expect(entries).toHaveLength(1);
    });
  });
});

// ─── Test D: readSessionMessages fallback ──────────────────────────
//
// readSessionMessages in session-utils.fs.ts checks Aeon first, then
// falls back to JSONL. When Aeon is absent or returns empty, verify
// JSONL still works.

describe("aeon-memory integration — readSessionMessages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockGetTranscript.mockClear().mockReturnValue([]);
    mockIsAvailable.mockClear().mockReturnValue(false);
    mockGetInstance.mockClear().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to JSONL when aeon-memory is not installed", async () => {
    vi.doMock("aeon-memory", () => {
      throw new Error("MODULE_NOT_FOUND");
    });

    const { readSessionMessages } = await import("../gateway/session-utils.fs.js");

    // With no session file and no Aeon, should return empty array
    const messages = readSessionMessages("nonexistent-session", undefined);
    expect(messages).toEqual([]);
  });

  it("falls back to JSONL when Aeon has no data for the session", async () => {
    mockGetInstance.mockReturnValue({
      isAvailable: () => true,
      saveTurn: mockSaveTurn,
      getTranscript: mockGetTranscript.mockReturnValue([]),
    });

    vi.doMock("aeon-memory", () => ({
      AeonMemory: {
        getInstance: mockGetInstance,
      },
    }));

    const { readSessionMessages } = await import("../gateway/session-utils.fs.js");

    // Warm up the async lazy loader
    readSessionMessages("dummy", undefined);
    await new Promise((r) => setTimeout(r, 50));

    const messages = readSessionMessages("empty-aeon-session", undefined);
    // getTranscript returns [], so should fall through to JSONL → []
    expect(messages).toEqual([]);
  });

  it("returns Aeon data when plugin is available and has transcript", async () => {
    const fakeTranscript = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    mockGetInstance.mockReturnValue({
      isAvailable: () => true,
      saveTurn: mockSaveTurn,
      getTranscript: mockGetTranscript.mockReturnValue(fakeTranscript),
    });

    vi.doMock("aeon-memory", () => ({
      AeonMemory: {
        getInstance: mockGetInstance,
      },
    }));

    const { readSessionMessages } = await import("../gateway/session-utils.fs.js");

    // Warm up the async lazy loader
    readSessionMessages("dummy", undefined);
    await new Promise((r) => setTimeout(r, 50));

    const messages = readSessionMessages("aeon-session-123", undefined);
    expect(messages).toEqual(fakeTranscript);
    expect(mockGetTranscript).toHaveBeenCalledWith("aeon-session-123");
  });
});
