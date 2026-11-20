import Link from "next/link";

import type { TeamRole } from "@tawd/core/enums";
import { roleLabels } from "@/lib/labels";

/* "Team: (JB) Jason (PM)  Edit team", in the project header. */

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : (parts[0]?.slice(0, 2) ?? "?");
  return letters.toUpperCase();
}

export function TeamLine({
  members,
  editHref,
}: {
  members: { id: string; name: string; roles: TeamRole[] }[];
  /** Absent when the viewer cannot change the team. */
  editHref?: string;
}) {
  return (
    <span className="team-line">
      <span className="team-line-label">Team:</span>
      {members.length === 0 ? (
        <span className="hint-missing">Nobody assigned</span>
      ) : (
        members.map((member) => (
          <span key={member.id} className="team-member">
            <span className="avatar avatar-small" aria-hidden="true">
              {initialsOf(member.name)}
            </span>
            {member.name.split(/\s+/)[0]}
            {member.roles.length > 0
              ? ` (${member.roles.map((r) => roleLabels[r]).join(", ")})`
              : ""}
          </span>
        ))
      )}
      {editHref ? (
        <Link href={editHref} className="team-line-edit">
          Edit team
        </Link>
      ) : null}
    </span>
  );
}
