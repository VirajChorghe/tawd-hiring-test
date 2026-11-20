"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveSiteVideosAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Videos from social links (Jason, 29 September 2026), on Option A's
  Mockups page: TikTok and Instagram links, one per line, a title after
  " | ". The site build makes a Videos page and fills the home page's
  featured videos with the first ones, all click-to-play.
*/
export function SiteVideosCard({ projectId, text, count, hasVideosPage, canEdit }: { projectId: string; text: string; count: number; hasVideosPage: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(text);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="card site-videos">
      <h2 className="card-title">Videos from social links</h2>
      <p className="hint">
        Paste TikTok and Instagram video links, one per line; add a title after &ldquo; | &rdquo; if you like. The site gets {hasVideosPage ? "its Videos page filled" : "a Videos page"} and the home
        page&rsquo;s featured videos show the first ones. Each plays only when a visitor clicks it: nothing loads from TikTok or Instagram before.
      </p>
      <div className="field">
        <label className="field-label" htmlFor={`videos-${projectId}`}>
          <span>Video links</span>
          <span className="field-optional">{count ? `${count} saved` : "Optional"}</span>
        </label>
        <textarea
          id={`videos-${projectId}`}
          className="textarea"
          rows={6}
          disabled={!canEdit || busy}
          placeholder={"https://www.tiktok.com/@karicrazyhuskylady/video/7412345678901234567 | Husky howl concert\nhttps://www.instagram.com/reel/C9AbCdEfGhI/"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      {message ? <p className={message.tone === "ok" ? "hint" : "hint-error"}>{message.text}</p> : null}
      {canEdit ? (
        <Button
          small
          disabled={busy}
          onClick={() =>
            start(async () => {
              setMessage(null);
              const result = await saveSiteVideosAction(projectId, value);
              if (!result.ok) setMessage({ tone: "error", text: result.message });
              else
                setMessage({
                  tone: "ok",
                  text: `Saved ${result.saved} video${result.saved === 1 ? "" : "s"}.${result.rejected.length ? ` Not a TikTok or Instagram video link, left out: ${result.rejected.join("; ")}` : ""}`,
                });
              router.refresh();
            })
          }
        >
          Save the videos
        </Button>
      ) : null}
    </div>
  );
}
