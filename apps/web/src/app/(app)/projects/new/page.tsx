import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { createProjectAction } from "@/app/actions";
import { ProjectForm } from "@/components/project-form";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { listAssignableUsers } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "New project - TAWD" };
export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const current = await requireUser();
  if (!can(current, "project.create")) redirect("/projects");

  const assignable = await listAssignableUsers(getDb());

  return (
    <div className="page page-narrow">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden="true">/</span>
        <span>New project</span>
      </nav>
      <div className="page-head">
        <div>
          <h1 className="page-title">New project</h1>
          <p className="page-lede">
            The basics. The intake comes next, and it starts at the Intake stage.
          </p>
        </div>
      </div>

      <ProjectForm
        action={createProjectAction}
        assignable={assignable}
        submitLabel="Create project and open intake"
        cancelHref="/projects"
      />
    </div>
  );
}
