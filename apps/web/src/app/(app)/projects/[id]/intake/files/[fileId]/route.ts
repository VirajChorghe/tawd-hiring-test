import { and, eq } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { intakeFile } from "@tawd/core/schema";
import { getStorage } from "@tawd/core/intake/storage";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";

/*
  An uploaded image, served from TAWD's own address to signed-in team
  members who can see the project. Same-origin, so the browser may read its
  pixels: "Suggest colors from the logo" works in the browser, with no AI.
  Sandboxed, since an SVG can carry script.
*/
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
): Promise<Response> {
  const { id, fileId } = await params;
  const current = await requireUser();
  const db = getDb();
  if (!(await getProject(db, current, id))) return new Response("Not found.", { status: 404 });

  const [file] = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.id, fileId), eq(intakeFile.projectId, id), eq(intakeFile.status, "ready")))
    .limit(1);
  if (!file || !file.contentType.startsWith("image/")) return new Response("Not found.", { status: 404 });
  const body = await getStorage().get(file.storageKey);
  if (!body) return new Response("Not found.", { status: 404 });

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
}
