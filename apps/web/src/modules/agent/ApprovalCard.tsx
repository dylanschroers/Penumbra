import {
  type ApprovalRequest,
  answerApproval,
  usePendingApprovals,
} from "../../agent/approvals";
import type { DiffLine } from "../../agent/lineDiff";

const MARK: Record<DiffLine["kind"], string> = {
  same: " ",
  add: "+",
  del: "-",
  skip: "…",
};

function Diff({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) {
    return <p className="approval__note">No changes to the contents.</p>;
  }
  return (
    <pre className="approval__diff">
      {lines.map((line, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed diff, never reordered
          key={i}
          className={`approval__line approval__line--${line.kind}`}
        >
          {MARK[line.kind]} {line.text}
        </div>
      ))}
    </pre>
  );
}

function Card({ request }: { request: ApprovalRequest }) {
  return (
    <section className="approval" aria-label={request.title}>
      <div className="approval__title">{request.title}</div>
      <div className="approval__path">
        {request.path}
        {request.to && <> → {request.to}</>}
      </div>
      {request.diff && <Diff lines={request.diff} />}
      <div className="approval__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => answerApproval(request.id, true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => answerApproval(request.id, false)}
        >
          Decline
        </button>
      </div>
    </section>
  );
}

/** File changes the agent is waiting on the user to approve. */
export function PendingApprovals() {
  const pending = usePendingApprovals();
  return pending.map((request) => <Card key={request.id} request={request} />);
}
