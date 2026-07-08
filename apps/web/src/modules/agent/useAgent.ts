import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatus, ChatMessage, InferenceEngine } from "@ghost/shared";
import { defaultEngine } from "../../engine";

// Drives the agent module: tracks backend status and runs a streaming chat turn.
// It talks to an InferenceEngine, not a transport — the embedded LocalEngine by
// default (Tier 0, no server), or a RemoteEngine behind a self-hosted/cloud
// backend. This hook owns only UI concerns: message state, streaming, and abort.

// A message as the UI holds it: the wire contract plus the model's reasoning,
// streamed on a side channel and rendered apart from the answer. `reasoning` is
// display-only — it is never sent back in history (see `history` below).
export type DisplayMessage = ChatMessage & { reasoning?: string };

export function useAgent(engine: InferenceEngine = defaultEngine) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "stopped" });
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await engine.getStatus());
  }, [engine]);

  // Poll status so the pill reflects the backend starting/stopping out of band.
  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), 5000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      // What we send: role + content only. Reasoning stays client-side so the
      // model is never fed back its own raw chain-of-thought.
      const history: ChatMessage[] = [
        ...messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: trimmed },
      ];
      // Add the user turn plus an empty assistant turn we'll stream into.
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: "", reasoning: "" },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const appendToAssistant = (
        field: "content" | "reasoning",
        chunk: string,
      ) =>
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last) return prev;
          next[next.length - 1] = { ...last, [field]: (last[field] ?? "") + chunk };
          return next;
        });

      try {
        for await (const chunk of engine.streamReply(history, controller.signal)) {
          appendToAssistant(chunk.kind === "reasoning" ? "reasoning" : "content", chunk.text);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          appendToAssistant("content", `\n\n⚠️ ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [engine, messages, streaming],
  );

  return { messages, status, streaming, send };
}
