import { MockupError } from "@/lib/mockups";
import { buildClientPack } from "@/lib/concept-review";
import { getServiceContext } from "@/lib/server-context";
import { requireUser } from "@/lib/session";
import { PermissionError } from "@tawd/core/permissions";

/*
  Download client pack: the ticked concepts as desktop images in one zip.
  A GET, so the browser treats it as a download; logged in the activity
  log like any other action.
*/
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const current = await requireUser();

  try {
    const pack = await buildClientPack(await getServiceContext(), current, id);
    return new Response(Buffer.from(pack.body), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${pack.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      return new Response("You do not have permission to do that.", { status: 403 });
    }
    if (error instanceof MockupError) {
      return new Response(error.message, { status: 409 });
    }
    throw error;
  }
}
