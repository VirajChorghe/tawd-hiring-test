import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";

/*
  Lane 2, Option B: the designer's own design, imported from Figma, shown
  first on the Mockups page as "The designer's Figma design" (Concept 1 on the board is the improved version). The team
  sees who made it; the client pack never says so (neutral labels only).
  The homepage frame is shown large, the other final frames beside it.
*/

export interface DesignerDesignProps {
  projectId: string;
  /** Null until the Figma link is saved. */
  fileName: string | null;
  figmaUrl: string | null;
  status: "not_linked" | "not_imported" | "importing" | "imported" | "failed";
  importedLine: string | null;
  failure: string | null;
  warnings: number;
  outOfDate: boolean;
  frames: { id: string; name: string; isHome: boolean; imageUrl: string | null; width: number; height: number }[];
  /** Where the design came from: Figma, an uploaded PDF, or uploaded images. */
  source?: "figma" | "pdf" | "upload";
}

/* The card's words for each source. */
function sourceWords(source: DesignerDesignProps["source"]) {
  if (source === "pdf" || source === "upload") {
    const kind = source === "pdf" ? "uploaded PDF" : "uploaded images";
    return { title: `The designer\u2019s design (${kind})`, from: "Uploaded", section: "Design section", unit: "page", label: `The designer's design (${kind})` };
  }
  return { title: "The designer\u2019s Figma design", from: "From Figma", section: "Figma section", unit: "frame", label: "The designer's Figma design" };
}

export function DesignerDesign(props: DesignerDesignProps) {
  const intake = `/projects/${props.projectId}/intake?section=figma`;
  const words = sourceWords(props.source);
  const home = props.frames.find((f) => f.isHome) ?? props.frames[0];
  const others = props.frames.filter((f) => f !== home);

  if (props.status !== "imported" || !home) {
    const [title, line] =
      props.status === "not_linked"
        ? ["No Figma design yet", "Paste the designer's Figma link in the intake. TAWD checks it and imports the final frames, for free."]
        : props.status === "importing"
          ? ["Importing the design", "The final frames are being rendered from Figma. This page updates when it is done."]
          : props.status === "failed"
            ? ["The import didn't finish", props.failure ?? "Try importing again from the intake."]
            : ["Not imported yet", "The Figma file has been checked. Import it from the intake to show the design here."];
    return (
      <section className="card designer-design" aria-label={words.label}>
        <div className="designer-design-head">
          <div>
            <p className="concept-card-title">{words.title}</p>
            <p className="hint">{title}. {line}</p>
          </div>
          <ButtonLink href={intake}>{props.status === "not_linked" ? "Add the Figma link" : "Open the Figma section"}</ButtonLink>
        </div>
      </section>
    );
  }

  return (
    <section className="card designer-design" aria-label={words.label}>
      <div className="designer-design-head">
        <div>
          <p className="concept-card-title">{words.title}</p>
          <p className="hint">
            {words.from}: {props.fileName}. {props.source === "figma" || !props.source ? "Imported" : "Read"} {props.importedLine}
          </p>
          <div className="concept-badges">
            <Badge kind="info">Designer&rsquo;s own</Badge>
            {props.warnings > 0 ? (
              <Badge kind="warning">
                {props.warnings} warning{props.warnings === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge kind="done">Ready</Badge>
            )}
            {props.outOfDate ? <Badge kind="warning">{props.source === "figma" || !props.source ? "Changed in Figma since" : "Uploaded again since"}</Badge> : null}
          </div>
        </div>
        <div className="designer-design-actions">
          <ButtonLink href={intake}>{words.section}</ButtonLink>
          {props.figmaUrl ? (
            <a className="btn btn-text" href={props.figmaUrl} target="_blank" rel="noreferrer">
              Open in Figma
            </a>
          ) : null}
        </div>
      </div>

      <div className="designer-design-body">
        <figure className="designer-design-main">
          <figcaption className="field-label">{home.name} (homepage)</figcaption>
          <div className="render-frame render-scroll">
            {home.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
              <img src={home.imageUrl} alt={`The designer's ${home.name} ${words.unit}`} width={home.width} height={home.height} />
            ) : (
              <p className="concept-render-empty">{props.source === "figma" || !props.source ? "Figma could not render this frame." : "There is no picture of this page."}</p>
            )}
          </div>
        </figure>

        {others.length > 0 ? (
          <ul className="designer-design-frames" aria-label={`The other ${words.unit}s`}>
            {others.map((frame) => (
              <li key={frame.id}>
                {frame.imageUrl ? (
                  <a href={frame.imageUrl} target="_blank" rel="noreferrer" className="designer-design-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link */}
                    <img src={frame.imageUrl} alt={`The designer's ${frame.name} ${words.unit}`} />
                  </a>
                ) : (
                  <div className="designer-design-thumb concept-render-empty">No picture</div>
                )}
                <p className="hint">{frame.name}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="hint">
        TAWD reviews and improves the homepage; the other {words.unit}s are kept for the site build.
      </p>
    </section>
  );
}
