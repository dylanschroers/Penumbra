import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_SYSTEM, runTool, toolSpecs } from "../../agent/tools";
import { type AgentStatus, type ChatMessage, localEngine } from "../../engine";

// Drives the agent module: tracks the embedded model's status and runs a
// tool-using turn against it (LocalEngine.runAgent — Tier 0, no server). This
// hook owns only UI concerns: message state, the busy flag, and abort. Tool
// execution lives in ../../agent/tools; the model just decides what to call.

/** One tool the model ran during a turn, shown inline in the thread. */
export type ToolStep = { name: string; result: string };
/** A message as the UI holds it: wire content plus any tool steps that ran. */
export type DisplayMessage = ChatMessage & { steps?: ToolStep[] };

export function useAgent() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await localEngine.getStatus());
  }, []);

  // Poll status so the pill reflects the model starting/stopping out of band.
  // Skip ticks while the tab is hidden; the next visible tick catches up.
  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // Cancel an in-flight turn when the module unmounts, so the tool loop stops
  // instead of patching state that no longer has a component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      // History is role + content only; tool steps are display-only and never
      // replayed (each turn runs a fresh tool loop).
      const history: ChatMessage[] = [
        ...messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: trimmed },
      ];
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: "", steps: [] },
      ]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Patch the trailing (assistant) message in place.
      const patch = (fn: (m: DisplayMessage) => DisplayMessage) =>
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (!last) return prev;
          next[next.length - 1] = fn(last);
          return next;
        });

      try {
        for await (const ev of localEngine.runAgent(
          history,
          { tools: toolSpecs, system: AGENT_SYSTEM, runTool },
          controller.signal,
        )) {
          if (ev.kind === "tool") {
            patch((m) => ({
              ...m,
              steps: [...(m.steps ?? []), { name: ev.name, result: ev.result }],
            }));
          } else {
            patch((m) => ({ ...m, content: ev.text }));
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const note = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
          patch((m) => ({ ...m, content: `${m.content}\n\n${note}`.trim() }));
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [messages, busy],
  );

  return { messages, status, busy, send };
}
