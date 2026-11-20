"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  createTeamMemberAction,
  deleteTeamMemberAction,
  resetTeamMemberPasswordAction,
  setTeamMemberDisabledAction,
  updateTeamMemberAction,
  type TeamActionResult,
} from "@/app/actions";
import { initialsOf } from "@/components/project/team-line";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { teamRoles, type TeamRole } from "@tawd/core/enums";
import { roleLabels } from "@/lib/labels";
import { useUnsavedChanges } from "@/lib/unsaved";

/*
  The Team page: everyone who can sign in, admins only.

  Every rule lives on the server - the last active admin cannot be removed
  or disabled, nobody can disable themselves, only velocitymedialab.com
  addresses, a temporary password shown once. This screen says so up front
  where it can (a disabled control with the reason) and otherwise shows the
  server's own message.
*/

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  isDisabled: boolean;
  mustChangePassword: boolean;
  roles: TeamRole[];
}

/*
  Active people by default. Disabled people appear only under Disabled, so
  the everyday list is the team as it is now.
*/
type Filter = "active" | "admins" | "disabled";

const FILTERS: [Filter, string][] = [
  ["active", "Active"],
  ["admins", "Admins"],
  ["disabled", "Disabled"],
];

export function TeamManager({
  users,
  currentUserId,
}: {
  users: TeamMember[];
  currentUserId: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const counts: Record<Filter, number> = {
    active: users.filter((u) => !u.isDisabled).length,
    admins: users.filter((u) => u.isAdmin && !u.isDisabled).length,
    disabled: users.filter((u) => u.isDisabled).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((user) => {
      if (filter === "disabled" ? !user.isDisabled : user.isDisabled) return false;
      if (filter === "admins" && !user.isAdmin) return false;
      if (!q) return true;
      return (
        user.name.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q)
      );
    });
  }, [users, query, filter]);

  const editing = users.find((u) => u.id === editingId) ?? null;
  const activeAdmins = users.filter((u) => u.isAdmin && !u.isDisabled).length;

  return (
    <>
      <div className="page-head team-head">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-lede">
            Everyone who can sign in to TAWD. Only admins see this page.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add team member
        </Button>
      </div>

      <div className="team-toolbar">
        <label className="search-field">
          <span className="visually-hidden">Search by name or email</span>
          <SearchIcon />
          <input
            type="search"
            className="input"
            placeholder="Search by name or email"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="segment"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label} ({counts[value]})
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        <table className="team-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Team roles</th>
              <th>Access</th>
              <th>Status</th>
              <th className="align-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty-cell">
                  {query.trim()
                    ? `Nobody matches "${query.trim()}".`
                    : filter === "disabled"
                      ? "Nobody is disabled."
                      : "Nobody here yet. Add the first team member."}
                </td>
              </tr>
            ) : (
              shown.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="person">
                      <span className="avatar" aria-hidden="true">
                        {initialsOf(user.name)}
                      </span>
                      <div>
                        <div className="person-name">
                          {user.name}
                          {user.id === currentUserId ? (
                            <Badge kind="info">You</Badge>
                          ) : null}
                        </div>
                        <div className="person-email">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {user.roles.length === 0 ? (
                      <span className="hint-missing">No roles yet</span>
                    ) : (
                      <span className="row" style={{ gap: 6 }}>
                        {user.roles.map((role) => (
                          <span key={role} className="role-chip">
                            {roleLabels[role]}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    {user.isAdmin ? (
                      <Badge kind="info">Admin</Badge>
                    ) : (
                      <span className="hint">Team member</span>
                    )}
                  </td>
                  <td>
                    <StatusLine user={user} />
                  </td>
                  <td className="align-right">
                    <Button
                      small
                      aria-label={`Edit ${user.name}`}
                      onClick={() => setEditingId(user.id)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <EditPanel
          key={editing.id}
          user={editing}
          isSelf={editing.id === currentUserId}
          isLastActiveAdmin={
            editing.isAdmin && !editing.isDisabled && activeAdmins <= 1
          }
          onClose={() => setEditingId(null)}
        />
      ) : null}

      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function StatusLine({ user }: { user: TeamMember }) {
  return (
    <div>
      <StatusBadge disabled={user.isDisabled} />
      {user.mustChangePassword ? (
        <div className="hint-missing">No password set yet</div>
      ) : null}
    </div>
  );
}

function StatusBadge({ disabled }: { disabled: boolean }) {
  return (
    <span className={disabled ? "status is-off" : "status is-on"}>
      <span className="status-dot" aria-hidden="true" />
      {disabled ? "Disabled" : "Active"}
    </span>
  );
}

/* ---------- edit side panel ---------- */

export function EditPanel({
  user,
  isSelf,
  isLastActiveAdmin,
  onClose,
}: {
  user: TeamMember;
  isSelf: boolean;
  isLastActiveAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [roles, setRoles] = useState<TeamRole[]>(user.roles);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEscape(onClose, busy);

  const dirty =
    name.trim() !== user.name ||
    isAdmin !== user.isAdmin ||
    [...roles].sort().join() !== [...user.roles].sort().join();

  useUnsavedChanges(dirty ? `${user.name}'s team details` : null);

  const run = (fn: () => Promise<TeamActionResult>, closeAfter = false) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.temporaryPassword) setPassword(result.temporaryPassword);
      setNotice(result.notice ?? null);
      router.refresh();
      if (closeAfter) onClose();
    });
  };

  const cannotDisable = !user.isDisabled && (isSelf || isLastActiveAdmin);

  return (
    <div
      className="panel-backdrop"
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <aside
        className="side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-member-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="side-panel-head">
          <div>
            <h2 id="edit-member-title" className="section-title">
              {user.name}
            </h2>
            <p className="hint">{user.email}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="side-panel-body">
          <div className="field">
            <label className="field-label" htmlFor="member-name">
              <span>Name</span>
            </label>
            <input
              id="member-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <RolePicker value={roles} onChange={setRoles} />

          <div className="panel-box panel-box-row">
            <div>
              <p className="card-title">Admin access</p>
              <p className="hint">
                Can manage accounts and read the full activity log.
              </p>
              {isLastActiveAdmin ? (
                <p className="hint-missing" style={{ marginTop: 6 }}>
                  The last active admin. Make someone else an admin first.
                </p>
              ) : null}
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={isAdmin}
                disabled={isLastActiveAdmin && isAdmin}
                onChange={(event) => setIsAdmin(event.target.checked)}
              />
              Admin
            </label>
          </div>

          <div className="panel-box">
            <div className="panel-box-row">
              <p className="card-title">Account</p>
              <StatusBadge disabled={user.isDisabled} />
            </div>
            <p style={{ margin: "10px 0 14px" }}>
              {user.isDisabled
                ? "Disabled. They can't sign in, but their history is kept."
                : "Active. They can sign in."}
              {user.mustChangePassword
                ? " They have not set their own password yet."
                : ""}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <Button
                disabled={busy || cannotDisable}
                onClick={() =>
                  run(() =>
                    setTeamMemberDisabledAction(user.id, !user.isDisabled),
                  )
                }
              >
                {user.isDisabled ? "Enable account" : "Disable account"}
              </Button>
              <Button
                disabled={busy}
                onClick={() => run(() => resetTeamMemberPasswordAction(user.id))}
              >
                Reset password
              </Button>
            </div>
            {!user.isDisabled && isSelf ? (
              <p className="hint" style={{ marginTop: 8 }}>
                You can&apos;t disable your own account.
              </p>
            ) : null}
            <p className="hint" style={{ marginTop: 12 }}>
              Reset password creates a temporary password shown once. They
              must change it at first sign-in.
            </p>
          </div>

          <DeleteMemberArea
            user={user}
            isSelf={isSelf}
            isLastActiveAdmin={isLastActiveAdmin}
            onDeleted={onClose}
          />

          {password ? <TemporaryPassword value={password} /> : null}
          {notice && !password ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="hint-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="side-panel-foot">
          <Button onClick={onClose} disabled={busy}>
            {password ? "Done" : "Cancel"}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !dirty || name.trim().length === 0}
            onClick={() =>
              run(
                () => updateTeamMemberAction(user.id, { name, roles, isAdmin }),
                true,
              )
            }
          >
            {busy ? "Saving..." : "Save changes"}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

/* ---------- deleting someone ---------- */

function DeleteMemberArea({
  user,
  isSelf,
  isLastActiveAdmin,
  onDeleted,
}: {
  user: TeamMember;
  isSelf: boolean;
  isLastActiveAdmin: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const blocker = isSelf
    ? "You can't delete your own account."
    : isLastActiveAdmin
      ? "The last active admin can't be deleted. Make someone else an admin first."
      : null;

  return (
    <div className="panel-box panel-danger">
      <p className="card-title">Delete team member</p>
      <p className="hint">
        Removes their sign-in, roles and project places for good. Their history
        is kept and shown as &ldquo;(deleted user) {user.name}&rdquo;. To stop them signing
        in for now, disable the account instead.
      </p>
      {blocker ? <p className="hint-missing" style={{ marginTop: 8 }}>{blocker}</p> : null}
      <div style={{ marginTop: 12 }}>
        <Button variant="danger" disabled={blocker !== null} onClick={() => setOpen(true)}>
          Delete {user.name}
        </Button>
      </div>
      {open ? (
        <DeleteMemberDialog user={user} onCancel={() => setOpen(false)} onDeleted={onDeleted} />
      ) : null}
    </div>
  );
}

export function DeleteMemberDialog({
  user,
  onCancel,
  onDeleted,
}: {
  user: TeamMember;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="modal-backdrop modal-over-panel" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-member-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="delete-member-title" className="section-title">
          Delete {user.name}?
        </h2>
        <p className="hint">
          They can no longer sign in, and they come off every project. The
          activity log keeps every entry they made and records this deletion
          with your name, the time and your reason.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="delete-member-name">
            <span>
              Type <strong>{user.name}</strong> to confirm
            </span>
            <span className="field-required">Required</span>
          </label>
          <input
            id="delete-member-name"
            className="input"
            value={typed}
            autoComplete="off"
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="delete-member-reason">
            <span>Reason</span>
            <span className="field-required">Required</span>
          </label>
          <textarea
            id="delete-member-reason"
            className="textarea"
            value={reason}
            placeholder="For example: left VML at the end of September."
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="hint">At least 10 characters. Recorded in the activity log.</p>
        </div>

        {error ? <p className="hint-error" role="alert">{error}</p> : null}

        <div className="modal-actions">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || typed.trim() !== user.name || reason.trim().length < 10}
            onClick={() => {
              setError(null);
              start(async () => {
                const result = await deleteTeamMemberAction(user.id, typed, reason);
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                router.refresh();
                onDeleted();
              });
            }}
          >
            {busy ? "Deleting..." : "Delete permanently"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------- add dialog ---------- */

export function AddDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [busy, start] = useTransition();

  useEscape(onClose, busy);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-member-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="add-member-title" className="section-title">
          {created ? "Account created" : "Add a team member"}
        </h2>

        {created ? (
          <>
            <p className="hint">
              {created.email} can now sign in with the password below. It is
              shown once: copy it now and share it with them privately.
            </p>
            <TemporaryPassword value={created.password} />
            <div className="modal-actions">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              There is no sign-up page. Accounts exist only because an admin
              creates them here.
            </p>

            <div className="field">
              <label className="field-label" htmlFor="new-name">
                <span>Name</span>
              </label>
              <input
                id="new-name"
                className={fieldErrors.name ? "input is-error" : "input"}
                placeholder="First and last name"
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              {fieldErrors.name ? (
                <p className="hint-error">{fieldErrors.name}</p>
              ) : null}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="new-email">
                <span>Email</span>
              </label>
              <input
                id="new-email"
                type="email"
                className={fieldErrors.email ? "input is-error" : "input"}
                placeholder="name@velocitymedialab.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              {fieldErrors.email ? (
                <p className="hint-error">{fieldErrors.email}</p>
              ) : (
                <p className="hint">Must be a velocitymedialab.com address.</p>
              )}
            </div>

            <RolePicker value={roles} onChange={setRoles} />

            <label className="check-label">
              <input
                type="checkbox"
                checked={isAdmin}
                onChange={(event) => setIsAdmin(event.target.checked)}
              />
              Admin: can manage accounts and read the full activity log
            </label>

            <p className="note-box">
              After creating, TAWD shows a temporary password once. Share it
              with them privately; they set their own at first sign-in.
            </p>

            {error ? (
              <p className="hint-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="modal-actions">
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setFieldErrors({});
                  start(async () => {
                    const result = await createTeamMemberAction({
                      name,
                      email,
                      roles,
                      isAdmin,
                    });
                    if (!result.ok) {
                      setError(result.message);
                      setFieldErrors(result.fieldErrors ?? {});
                      return;
                    }
                    setCreated({
                      email: email.trim().toLowerCase(),
                      password: result.temporaryPassword ?? "",
                    });
                    router.refresh();
                  });
                }}
              >
                {busy ? "Creating..." : "Create account"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- shared pieces ---------- */

function RolePicker({
  value,
  onChange,
}: {
  value: TeamRole[];
  onChange: (roles: TeamRole[]) => void;
}) {
  return (
    <fieldset className="role-picker">
      <legend className="field-label">
        <span>Team roles</span>
      </legend>
      <div className="row" style={{ gap: 8 }}>
        {teamRoles.map((role) => {
          const on = value.includes(role);
          return (
            <button
              key={role}
              type="button"
              className="role-toggle"
              aria-pressed={on}
              onClick={() =>
                onChange(on ? value.filter((r) => r !== role) : [...value, role])
              }
            >
              {roleLabels[role]}
            </button>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        A person can hold several roles. Roles decide who approves what.
      </p>
    </fieldset>
  );
}

export function TemporaryPassword({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-box">
      <p className="field-label">
        <span>Temporary password (shown once)</span>
      </p>
      <div className="row" style={{ gap: 8 }}>
        <code className="secret-value">{value}</code>
        <Button
          small
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function useEscape(onClose: () => void, busy: boolean) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, busy]);
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
