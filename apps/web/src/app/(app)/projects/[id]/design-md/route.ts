import { loadClientDesignDoc } from "@/lib/client-design";
import { requireUser } from "@/lib/session";
import { getDb } from "@tawd/core/db";

/*
  The client's DESIGN.md as a file: shown in the browser, or downloaded
  with ?download=1. Team only, like every project screen.
*/
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  await requireUser();
  const doc = await loadClientDesignDoc(getDb(), id);
  if (!doc) return new Response("This project has no DESIGN.md yet: it is written when the client approves a mockup.", { status: 404 });
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(doc.markdown, {
    headers: {
      "Content-Type": download ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
      ...(download ? { "Content-Disposition": 'attachment; filename="DESIGN.md"' } : {}),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
