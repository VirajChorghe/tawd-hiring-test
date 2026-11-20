import { getDb } from "@tawd/core/db";
import { assetFile } from "@/lib/design-read-assets";
import { requireUser } from "@/lib/session";

/*
  One picture from a new design read's asset sheet (E4b-1, Lane 2), for the
  admin panel. Admins only; the runId, the name and the sheet are all checked
  in assetFile (lib/design-read-assets.ts). Every file there is a PNG the
  worker wrote, served sandboxed like the intake's own images.
*/
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string; file: string }> },
): Promise<Response> {
  const { id, runId, file } = await params;
  const current = await requireUser();
  const body = await assetFile(getDb(), current, id, runId, file);
  if (!body) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
}
