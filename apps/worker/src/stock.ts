import { and, eq } from "drizzle-orm";

import { stockPicture } from "@tawd/core/schema";
import { projectStoragePrefix } from "@tawd/core/intake/storage";
import { applyStockPictures, stockClash, stockPicks, stockQueries, type CheckIssue, type RunNote, type StockPicture } from "@tawd/core/mockups";

import type { Db, Storage } from "./pipeline";

/*
  Shutterstock previews for the mockups' placeholder frames (see core
  mockups/stock.ts for what the page carries). This side searches, keeps
  the watermarked preview in R2 under the project, and remembers every
  phrase's answer in stock_picture, so each phrase is looked up once per
  project however many fix rounds and renders follow.

  Needs SHUTTERSTOCK_CLIENT_ID and SHUTTERSTOCK_CLIENT_SECRET. Without
  them nothing is searched and the frames stay labeled boxes, as before.
  Search and previews only: nothing is licensed or bought.
*/

export interface StockHit {
  id: string;
  description: string | null;
  previewUrl: string;
}

export interface StockClient {
  search(query: string): Promise<StockHit | null>;
  /** Up to five hits, best first, so one that clashes with the brand can be passed over (27 September 2026). */
  searchAll?(query: string): Promise<StockHit[]>;
  download(url: string): Promise<Buffer>;
}

/* The brand a project's stock must fit: its colours and the competitors the client named. */
export interface StockBrand {
  colors: string[];
  competitors: string[];
  /** The trade in plain words ("pest control"), added to a phrase that doesn't name it. */
  trade?: string;
}

/*
  The phrase Shutterstock is asked: the page's own phrase, with the trade in
  front when the phrase doesn't name it (8 October 2026: "traps" alone found
  fishing traps on a pest control page). The saved row keeps the page's phrase.
*/
/* The searches tried in order, each only when the one before found nothing. */
export function fallbackPhrases(query: string, trade: string | undefined): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [searchPhrase(query, trade)];
  if (words.length > 2) out.push(searchPhrase(words.slice(-2).join(" "), trade));
  if (trade) out.push(`${trade.toLowerCase()} technician at work`);
  return [...new Set(out)];
}

/*
  #2 from the New Dawn run (7 November 2026): the chosen picture must match
  the frame's own subject, not just avoid a brand clash. Shutterstock answers
  in its own relevance order, but the fallback searches ask a simpler phrase
  (which can drop the distinguishing word: "aluminum lattice patio cover" →
  "patio cover"), and the old pick was the first non-clashing hit — so a
  "lattice patio cover" frame could come back a garden trellis. Each hit is
  now scored by how many of the page phrase's own distinctive words (filler
  dropped, simple plurals folded) its description carries, and the
  best-scoring non-clashing hit wins. A clashing hit never beats a clean one,
  whatever its score (a competitor's picture is worse than a loose subject),
  and on a tie Shutterstock's order stands, so vague descriptions pick as
  before. Code, no AI (standing rule 6).
*/
const FILLER = new Set(["the", "and", "for", "with", "from", "into", "onto", "over", "under", "near", "their", "that", "this"]);
const fold = (word: string) => (word.length > 3 ? word.replace(/s$/, "") : word);
export function subjectScore(description: string | null | undefined, query: string): number {
  const have = new Set((description ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(fold));
  if (have.size === 0) return 0;
  let score = 0;
  for (const word of new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !FILLER.has(w)).map(fold))) {
    if (have.has(word)) score += 1;
  }
  return score;
}

export function searchPhrase(query: string, trade: string | undefined): string {
  if (!trade) return query;
  const words = trade.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return words.some((w) => query.toLowerCase().includes(w)) ? query : `${trade.toLowerCase()} ${query}`;
}

/** Previews come only from Shutterstock's own hosts, over https. */
export function isShutterstockPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "shutterstock.com" || host.endsWith(".shutterstock.com") || host.endsWith(".picdn.net"));
  } catch {
    return false;
  }
}

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
/** New lookups per page at most; the rest wait for the next render. */
const MAX_NEW_LOOKUPS = 8;

export function shutterstockClient(clientId: string, clientSecret: string): StockClient {
  const auth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const client: StockClient = {
    async search(query) {
      return (await client.searchAll!(query))[0] ?? null;
    },
    async searchAll(query) {
      const params = new URLSearchParams({
        query,
        image_type: "photo",
        orientation: "horizontal",
        safe: "true",
        sort: "relevance",
        per_page: "5",
      });
      const response = await fetch(`https://api.shutterstock.com/v2/images/search?${params.toString()}`, {
        headers: { Authorization: auth, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "Shutterstock refused the keys (check SHUTTERSTOCK_CLIENT_ID and SHUTTERSTOCK_CLIENT_SECRET)."
            : `Shutterstock search answered ${response.status}.`,
        );
      }
      const body = (await response.json()) as {
        data?: { id?: string; description?: string; assets?: Record<string, { url?: string } | undefined> }[];
      };
      return (body.data ?? []).flatMap((hit) => {
        const url = hit.assets?.preview_1000?.url ?? hit.assets?.preview?.url;
        return hit.id && url ? [{ id: String(hit.id), description: hit.description ?? null, previewUrl: url }] : [];
      });
    },
    async download(url) {
      if (!isShutterstockPreviewUrl(url)) throw new Error("The preview is not on a Shutterstock address.");
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!response.ok) throw new Error(`The preview answered ${response.status}.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_PREVIEW_BYTES) throw new Error("The preview is larger than expected.");
      return bytes;
    },
  };
  return client;
}

let testClient: StockClient | null | undefined;

/** Tests pass a stand-in; null means "no keys". */
export function setStockClientForTesting(client: StockClient | null | undefined): void {
  testClient = client;
}

export function stockClientFromEnv(): StockClient | null {
  if (testClient !== undefined) return testClient;
  const id = process.env.SHUTTERSTOCK_CLIENT_ID?.trim();
  const secret = process.env.SHUTTERSTOCK_CLIENT_SECRET?.trim();
  return id && secret ? shutterstockClient(id, secret) : null;
}

const JPEG = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8;
const PNG = (bytes: Buffer) => bytes[0] === 0x89 && bytes[1] === 0x50;

/*
  One project's pictures. ensure() looks up the phrases a page asks for
  (from memory, then stock_picture, then Shutterstock); apply() fills the
  frames. apply() is synchronous so the many places that render a page
  (checks, versions, reviews) can call it as they call withImages.
*/
/*
  One of the answers Shutterstock gave for a phrase, kept on the row so a
  second concept can take a different picture without a second search (F28).
  imageKey is filled the first time a concept actually takes it.
*/
interface StoredCandidate {
  id: string;
  description: string | null;
  previewUrl: string | null;
  clash: string | null;
  imageKey?: string | null;
}

export class StockPictures {
  private readonly pictures = new Map<string, StockPicture | null>();
  /** Why a phrase's picture may clash with the brand, when it does. */
  private readonly clashes = new Map<string, string>();
  /*
    How well each phrase's picture matches what the frame asked for (stage 1
    of docs/plans/self-check.md). Until now a picture that did not match was
    silent: the Creative Director saw a photo that did not suit its place and
    marked the concept down for a choice the builder never made.

    Worked out from the picture's own saved description every time it is
    loaded, not stored - so a later version of a concept reports exactly what
    the first one did (CodeRabbit, PR #64: when this was recorded only while
    searching, the note appeared on v1 and silently vanished afterwards).
  */
  private readonly subjects = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly projectId: string,
    private readonly client: StockClient | null,
    private readonly brand: StockBrand = { colors: [], competitors: [] },
    /*
      F28: which concept is asking. Two concepts in one project used to be
      handed the same photograph for the same phrase, because the search was
      saved per project and only its winner was kept. With a concept named,
      each takes a different one of the answers the search already returned.
      Left out (Build A, the design flows), the behaviour is exactly as
      before: the phrase's own saved picture.
    */
    private readonly conceptId: string | null = null,
  ) {}

  /* Stock on this page that may clash with the brand: a warning for the team, never a block. */
  issues(html: string): CheckIssue[] {
    return stockQueries(html)
      .filter((query) => this.pictures.get(query) && this.clashes.has(query))
      .map((query) => ({ id: "stock.clash", severity: "warn" as const, message: `The stock picture for "${query}": ${this.clashes.get(query)} Swap it before the client sees it.` }));
  }

  /*
    What code settled rather than the builder, for the frames on this page.
    A picture found by a simpler search, or one matching none of the frame's
    own words, is reported; a clean match on the frame's own phrase is not,
    because nothing was substituted.
  */
  runNotes(html: string): RunNote[] {
    const notes: RunNote[] = [];
    for (const query of stockQueries(html)) {
      if (!this.pictures.get(query)) continue;
      if (this.subjects.get(query) !== 0) continue;
      notes.push({
        step: "stock",
        action: "chose",
        what: `the picture for "${query}"`,
        with: "one whose description matches none of that phrase's own subject words",
        /*
          Only what is true of the picture TAWD used. It must not claim no
          matching answer existed: a hit that matched the subject can be
          passed over for a brand clash, and then one did (CodeRabbit, #64).
        */
        why: "it was the best of the answers TAWD could use, and an empty frame is worse than a loose match",
      });
    }
    return notes;
  }

  /** How many of the page's stock frames have a picture (8 October 2026: an unfilled frame isn't a picture). */
  filled(html: string): number {
    return stockQueries(html).filter((query) => Boolean(this.pictures.get(query))).length;
  }

  /** Whether Shutterstock is set up, so the builder may count on stock frames being filled. */
  get available(): boolean {
    return this.client !== null;
  }

  async ensure(html: string): Promise<void> {
    const wanted = stockQueries(html).filter((q) => !this.pictures.has(q));
    if (wanted.length === 0) return;
    let lookups = 0;
    /*
      F28: what this page already says it took. A stored concept carries its
      own pick, so the review, a polish pass and a changes run all load the
      same photograph without knowing which concept they are looking at.
    */
    const asked = stockPicks(html);

    for (const query of wanted) {
      const [row] = await this.db
        .select()
        .from(stockPicture)
        .where(and(eq(stockPicture.projectId, this.projectId), eq(stockPicture.query, query)))
        .limit(1);

      if (row && row.status !== "failed") {
        const mine = row.status === "found" ? await this.pictureFor(row, asked[query]) : null;
        this.pictures.set(query, mine ? await this.load(mine.imageKey, mine.id) : null);
        /*
          Scored against the description of the picture this concept is
          actually shown, not the row's winner. The two were the same until
          F28 gave each concept a different one of the answers, and scoring
          the winner's words would have described someone else's picture.
        */
        if (mine) this.subjects.set(query, subjectScore(mine.description, query));
        if (mine?.clash) this.clashes.set(query, mine.clash);
        else if (!this.conceptId && row.clash) this.clashes.set(query, row.clash);
        continue;
      }
      if (!this.client || lookups >= MAX_NEW_LOOKUPS) continue;
      lookups += 1;
      await this.lookUp(query, row?.id ?? null);
    }
  }

  apply(html: string): string {
    if (this.pictures.size === 0) return html;
    // One colour treatment for every stock picture: a light wash of the brand's main colour.
    return applyStockPictures(html, Object.fromEntries(this.pictures), { tint: this.brand.colors[0] ?? null });
  }

  /*
    F28. The picture this concept takes for a phrase that has already been
    searched. Without a concept named, or with nothing else on offer, that is
    simply the phrase's own saved picture, as it always was.

    A concept keeps whatever it took before, so a fix round or a rebuild
    never changes the photographs under the team's feet. A concept asking
    first takes the best answer still free; when the answers run out,
    concepts share again rather than a frame going empty - a repeat is worse
    than a blank only in theory.

    Concept jobs run one at a time (the render queue's concurrency is 1), so
    read-then-write on taken_by does not race. If that ever changes, this
    needs the write to be conditional.
  */
  private async pictureFor(
    row: typeof stockPicture.$inferSelect,
    askedId: string | undefined,
  ): Promise<{ id: string; imageKey: string; clash: string | null; description: string | null } | null> {
    const own = (r: typeof stockPicture.$inferSelect) =>
      r.imageKey && r.shutterstockId ? { id: r.shutterstockId, imageKey: r.imageKey, clash: r.clash, description: r.description } : null;
    if (!this.conceptId && !askedId) return own(row);

    /*
      Choosing is done under a row lock, and only the choosing (CodeRabbit,
      PR #65). CONCEPT_QUEUE runs two concept jobs at once by default
      (TAWD_CONCEPTS_AT_ONCE), so two siblings can read the same empty
      taken_by, pick the same picture and overwrite each other - F28 passing
      every sequential test and still failing in production. A comment here
      claimed concept jobs ran one at a time; that is true of renders, not
      of concept jobs, and it was my assumption rather than the code's.

      The download stays outside the lock: it is slow, and storing a preview
      twice under the same id is harmless because the id names the file.
    */
    const chosen = await this.db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(stockPicture).where(eq(stockPicture.id, row.id)).for("update");
      if (!fresh) return null;
      const mine = own(fresh);
      const taken = (fresh.takenBy ?? {}) as Record<string, string>;
      const candidates = ((fresh.candidates ?? []) as StoredCandidate[]).filter((c) => c && typeof c.id === "string");
      const byId = (id: string) =>
        mine && mine.id === id
          ? { id, imageKey: mine.imageKey as string | null, clash: mine.clash, previewUrl: null as string | null, description: mine.description }
          : (() => {
              const found = candidates.find((c) => c.id === id);
              return found
                ? { id: found.id, imageKey: found.imageKey ?? null, clash: found.clash ?? null, previewUrl: found.previewUrl ?? null, description: found.description ?? null }
                : null;
            })();

      /*
        The page's own answer comes first, whoever is asking: a stored
        concept says which picture it took, and that is the whole point of
        stamping it. It is written down as this concept's as well, which it
        had not been when the page was the only record of it.
      */
      const wanted = (askedId && byId(askedId)) || (this.conceptId ? (taken[this.conceptId] ? byId(taken[this.conceptId]!) : null) : null);
      if (wanted) {
        if (this.conceptId && taken[this.conceptId] !== wanted.id) {
          await tx
            .update(stockPicture)
            .set({ takenBy: { ...taken, [this.conceptId]: wanted.id } })
            .where(eq(stockPicture.id, fresh.id));
        }
        return { pick: wanted, fallback: mine, candidates };
      }
      if (!this.conceptId) return { pick: null, fallback: mine, candidates };

      const spokenFor = new Set(Object.values(taken));
      const free = [
        ...(mine && !spokenFor.has(mine.id)
          ? [{ id: mine.id, imageKey: mine.imageKey as string | null, clash: mine.clash, previewUrl: null as string | null, description: mine.description }]
          : []),
        ...candidates
          .filter((c) => !spokenFor.has(c.id) && (mine ? c.id !== mine.id : true))
          .map((c) => ({ id: c.id, imageKey: c.imageKey ?? null, clash: c.clash ?? null, previewUrl: c.previewUrl ?? null, description: c.description ?? null })),
      ];
      // A clean picture before a clashing one, otherwise the search's own order.
      const pick = free.find((c) => !c.clash) ?? free[0] ?? null;
      // Nothing left: concepts share rather than a frame going empty, and nothing is claimed.
      if (!pick) return { pick: null, fallback: mine, candidates };
      await tx
        .update(stockPicture)
        .set({ takenBy: { ...taken, [this.conceptId]: pick.id } })
        .where(eq(stockPicture.id, fresh.id));
      return { pick, fallback: mine, candidates };
    });

    if (!chosen) return null;
    if (!chosen.pick) return chosen.fallback;
    const { pick } = chosen;
    if (pick.imageKey) return { id: pick.id, imageKey: pick.imageKey, clash: pick.clash, description: pick.description };

    // Fetched outside the lock, then written back for whoever takes it next.
    const imageKey = pick.previewUrl ? await this.storePreview(pick.previewUrl, pick.id) : null;
    if (!imageKey) return chosen.fallback;
    await this.db
      .update(stockPicture)
      .set({ candidates: chosen.candidates.map((c) => (c.id === pick.id ? { ...c, imageKey } : c)) })
      .where(eq(stockPicture.id, row.id));
    return { id: pick.id, imageKey, clash: pick.clash, description: pick.description };
  }

  /* One named picture for a phrase: the row's own, or one of the other answers, fetched if it has not been yet. */
  /*
    What this page took, by phrase, for stamping into the stored version
    (F28). Only phrases whose picture is in hand appear.
  */
  picks(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [query, picture] of this.pictures) if (picture) out[query] = picture.id;
    return out;
  }

  /* A candidate's preview fetched and kept, named by its Shutterstock id so it is stored once. */
  private async storePreview(previewUrl: string, id: string): Promise<string | null> {
    if (!this.client || !isShutterstockPreviewUrl(previewUrl)) return null;
    try {
      const bytes = await this.client.download(previewUrl);
      if (!JPEG(bytes) && !PNG(bytes)) return null;
      const key = `${projectStoragePrefix(this.projectId)}stock/${id.replace(/[^\w-]/g, "")}.${PNG(bytes) ? "png" : "jpg"}`;
      await this.storage.put(key, bytes, PNG(bytes) ? "image/png" : "image/jpeg");
      return key;
    } catch {
      return null;
    }
  }

  private async load(key: string, id: string): Promise<StockPicture | null> {
    const bytes = await this.storage.get(key);
    if (!bytes) return null;
    return { id, dataUri: `data:${PNG(bytes) ? "image/png" : "image/jpeg"};base64,${bytes.toString("base64")}` };
  }

  private async lookUp(query: string, failedRowId: string | null): Promise<void> {
    const save = async (values: Partial<typeof stockPicture.$inferInsert> & { status: string }) => {
      if (failedRowId) {
        await this.db.update(stockPicture).set(values).where(eq(stockPicture.id, failedRowId));
      } else {
        await this.db.insert(stockPicture).values({ projectId: this.projectId, query, ...values }).onConflictDoNothing();
      }
    };

    try {
      // Pass over hits that clash with the brand; if every one does, keep the best and flag it.
      /*
        Simpler searches when the first finds nothing (8 October 2026: "moisture
        meter on a damp wall" found nothing and the card stayed an empty box):
        the page's phrase with the trade, then its last words with the trade,
        then a general scene of the trade at work.
      */
      let hits: StockHit[] = [];
      for (const asked of fallbackPhrases(query, this.brand.trade)) {
        hits = this.client!.searchAll ? await this.client!.searchAll(asked) : [await this.client!.search(asked)].filter((h): h is StockHit => h !== null);
        if (hits.length) break;
      }
      // Scored against the page's own phrase (not the simpler fallback asked), so a
      // fallback search's hits are still ranked by the frame's full subject (#2).
      const judged = hits.map((h) => ({ hit: h, clash: stockClash(h.description, this.brand.colors, this.brand.competitors), score: subjectScore(h.description, query) }));
      const bestOf = (list: typeof judged) => list.reduce((a, b) => (b.score > a.score ? b : a), list[0]!);
      const clean = judged.filter((j) => !j.clash);
      const chosen = clean.length > 0 ? bestOf(clean) : judged.length > 0 ? bestOf(judged) : undefined;
      const hit = chosen?.hit ?? null;
      const clash = chosen?.clash ?? null;
      if (!hit) {
        await save({ status: "none" });
        this.pictures.set(query, null);
        return;
      }
      const bytes = await this.client!.download(hit.previewUrl);
      if (!JPEG(bytes) && !PNG(bytes)) throw new Error("The preview is not a JPEG or PNG picture.");
      const key = `${projectStoragePrefix(this.projectId)}stock/${hit.id.replace(/[^\w-]/g, "")}.${PNG(bytes) ? "png" : "jpg"}`;
      await this.storage.put(key, bytes, PNG(bytes) ? "image/png" : "image/jpeg");
      /*
        Every other answer is kept too (F28), best first, so a sibling concept
        can take a different photograph with no further search. Only the
        winner's preview is fetched now; the rest are fetched if taken.
      */
      const others: StoredCandidate[] = judged
        .filter((j) => j.hit.id !== hit.id)
        .map((j) => ({ id: j.hit.id, description: j.hit.description ?? null, previewUrl: j.hit.previewUrl, clash: j.clash }));
      await save({
        status: "found",
        shutterstockId: hit.id,
        description: hit.description,
        imageKey: key,
        failureReason: null,
        clash,
        candidates: others,
        takenBy: this.conceptId ? { [this.conceptId]: hit.id } : {},
      });
      if (clash) this.clashes.set(query, clash);
      this.subjects.set(query, chosen?.score ?? 0);
      this.pictures.set(query, { id: hit.id, dataUri: `data:${PNG(bytes) ? "image/png" : "image/jpeg"};base64,${bytes.toString("base64")}` });
    } catch (error) {
      // Not fatal: the frame stays a labeled box, and the next render tries again.
      await save({ status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 300) : "The search failed." });
      console.warn(`Shutterstock lookup for "${query}" failed:`, error instanceof Error ? error.message : error);
    }
  }
}
