import { ContentError, buildCopyPack } from "@/lib/content-drafts";
import { requireUser } from "@/lib/session";
import { getDb } from "@tawd/core/db";

/*
  Download the copy pack: every approved page, one after another, as one
  HTML document the PM sends the client (7b). Placeholders are highlighted
  so the client sees what is still needed from them.
*/
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  await requireUser();
  try {
    const pack = await buildCopyPack(getDb(), id);
    return new Response(pack.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${pack.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ContentError) return new Response(error.message, { status: 409 });
    throw error;
  }
}
