import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  type ApprovalRequest,
  answerApproval,
  requestApproval,
  usePendingApprovals,
} from "./approvals";

describe("approvals", () => {
  it("waits for an answer and reports it", async () => {
    let shown: ApprovalRequest[] = [];
    function Probe() {
      shown = usePendingApprovals();
      return null;
    }
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));

    let answer: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      answer = requestApproval({ title: "Edit file", path: "/n/a.md" });
    });
    expect(shown.map((r) => r.path)).toEqual(["/n/a.md"]);

    await act(async () => answerApproval(shown[0]?.id ?? "", true));
    expect(await answer).toBe(true);
    expect(shown).toEqual([]);
    await act(async () => root.unmount());
  });

  it("declines when the turn is stopped", async () => {
    const controller = new AbortController();
    const answer = requestApproval(
      { title: "Move to Trash", path: "/n/a.md" },
      controller.signal,
    );
    controller.abort();
    expect(await answer).toBe(false);
  });
});
