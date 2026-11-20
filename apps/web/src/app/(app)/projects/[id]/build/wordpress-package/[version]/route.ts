import { makeWordPressPackage, WpPackageError } from "@/lib/wordpress-package";
import { getServiceContext } from "@/lib/server-context";
import { requireUser } from "@/lib/session";
import { PermissionError } from "@tawd/core/permissions";

/*
  Build B, B1 (1 October 2026): Download the WordPress package of one
  finished build. A GET, so the browser treats it as a download; logged.
*/
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) return new Response("Not found", { status: 404 });
  const current = await requireUser();

  try {
    const pack = await makeWordPressPackage(await getServiceContext(), current, id, v);
    return new Response(Buffer.from(pack.zip), {
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
    if (error instanceof WpPackageError) {
      return new Response(error.message, { status: 409 });
    }
    throw error;
  }
}
