import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { updateProjectAction } from "@/app/actions";
import { ProjectForm } from "@/components/project-form";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { getProject, listAssignableUsers } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Edit project - TAWD" };
export const dynamic = "force-dynamic";

/*
  The project's details: name, trade, tier, lane, concepts and team. Not its
  stage, which only changes through the stage flow and its gates.
*/
export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const current = await requireUser();
  if (!can(current, "project.edit")) redirect(`/projects/${id}`);

  const db = getDb();
  const project = await getProject(db, current, id);
  if (!project) notFound();

  const assignable = await listAssignableUsers(
    db,
    project.members.map((m) => m.id),
  );

  // The project id is fixed here on the server, so the browser cannot ask to
  // edit a different project by editing the form.
  const action = updateProjectAction.bind(null, id);

  return (
    <div className="page page-narrow">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/projects/${id}`}>{project.clientName}</Link>
        <span aria-hidden="true">/</span>
        <span>Edit details</span>
      </nav>
      <div className="page-head">
        <div>
          <h1 className="page-title">Edit project details</h1>
          <p className="page-lede">
            The stage is not changed here: it moves on through the stage flow
            and its gates.
          </p>
        </div>
      </div>

      <ProjectForm
        action={action}
        assignable={assignable}
        submitLabel="Save changes"
        cancelHref={`/projects/${id}`}
        initial={{
          clientName: project.clientName,
          trade: project.trade,
          tier: project.tier,
          lane: project.lane,
          laneOption: project.laneOption,
          conceptCount: project.conceptCount,
          memberUserIds: project.members.map((m) => m.id),
        }}
      />
    </div>
  );
}
