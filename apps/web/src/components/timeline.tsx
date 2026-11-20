import { describeAction, formatWhen } from "@/lib/labels";
import { describeChanges } from "@/lib/timeline-text";

export interface TimelineItem {
  seq: number;
  occurredAt: Date;
  action: string;
  actorName: string | null;
  actorEmail: string | null;
  valueBefore: unknown;
  valueAfter: unknown;
}

/*
  The project's History: what happened, who did it, when, and a plain line
  about what changed. The exact values stay in the activity log.
*/
export function Timeline({
  items,
  people,
}: {
  items: TimelineItem[];
  /** Everyone's name by id, for "Added Dee Morgan". */
  people: Map<string, string>;
}) {
  if (items.length === 0) {
    return <p className="hint">Nothing has happened on this project yet.</p>;
  }

  return (
    <ul className="timeline">
      {items.map((item) => {
        const changes = describeChanges(item.action, item.valueBefore, item.valueAfter, people);
        const who =
          item.actorName ??
          (item.actorEmail?.startsWith("system") ? "TAWD" : (item.actorEmail ?? "TAWD"));

        return (
          <li key={item.seq} className="timeline-item">
            <div className="timeline-head">
              <strong>{describeAction(item.action)}</strong>
              <span className="timeline-when">
                {who} · {formatWhen(item.occurredAt)}
              </span>
            </div>
            {changes.map((line, i) => (
              <p key={i} className="timeline-change">
                {line}
              </p>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
