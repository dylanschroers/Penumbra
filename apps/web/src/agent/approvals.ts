import { useSyncExternalStore } from "react";
import type { DiffLine } from "./lineDiff";

// Changes the agent wants to make to files, waiting on the user. The file tools
// run outside React, so this is a small store the chat subscribes to.

export interface ApprovalRequest {
  id: string;
  /** What will happen, e.g. "Edit file". */
  title: string;
  /** The path it happens to, plus a destination for a move. */
  path: string;
  to?: string;
  diff?: DiffLine[];
}

interface Pending extends ApprovalRequest {
  resolve: (approved: boolean) => void;
}

let pending: Pending[] = [];
let snapshot: ApprovalRequest[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function publish(next: Pending[]): void {
  pending = next;
  snapshot = next.map(({ resolve: _, ...request }) => request);
  for (const listener of listeners) listener();
}

/** Ask the user. Resolves false when declined or when `signal` aborts the turn. */
export function requestApproval(
  request: Omit<ApprovalRequest, "id">,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = `approval-${++nextId}`;
    const abort = () => answerApproval(id, false);
    signal?.addEventListener("abort", abort, { once: true });
    publish([
      ...pending,
      {
        ...request,
        id,
        resolve: (approved) => {
          signal?.removeEventListener("abort", abort);
          resolve(approved);
        },
      },
    ]);
  });
}

export function answerApproval(id: string, approved: boolean): void {
  const found = pending.find((p) => p.id === id);
  if (!found) return;
  publish(pending.filter((p) => p.id !== id));
  found.resolve(approved);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingApprovals(): ApprovalRequest[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}
