import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityLog, intakeFile } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { confirmUpload, requestUpload } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  F-041 (batch C6): confirming an upload checks the file's first bytes against
  its declared type, reads only those bytes (a ranged read), and checks the
  size from head() before anything is downloaded.
*/

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  r2 = new FakeR2();
  seeded = null;
  setStorageForTesting(r2);
});
afterEach(async () => {
  setStorageForTesting(null);
  await h.close();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PDF = Buffer.from("%PDF-1.7\n" + "x".repeat(60));
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");

let seeded: Awaited<ReturnType<typeof seedProject>> | null = null;
async function setup() {
  seeded ??= await seedProject();
  return seeded;
}
async function seedProject() {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Sacramento Drain Pros",
    trade: "plumbing",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "intake",
    memberUserIds: [],
  });
  return { admin, projectId };
}

async function arrive(kind: "logo" | "photo" | "brand_guide", name: string, type: string, body: Buffer) {
  const { admin, projectId } = await setup();
  const ticket = await requestUpload(h.ctx, admin.viewer, projectId, kind, name, type, body.length);
  r2.objects.set(ticket.uploadUrl, body);
  return { admin, ticket, key: ticket.uploadUrl };
}
const rowOf = async (id: string) => (await h.db.select().from(intakeFile).where(eq(intakeFile.id, id)))[0];

describe("confirming an upload checks the bytes against the declared type (F-041)", () => {
  it("refuses a .png that is really HTML, and deletes the object and the record", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", HTML);
    // R2 keeps the Content-Type the upload was signed with, so the stored object does claim a type.
    r2.head = async () => ({ sizeBytes: HTML.length, contentType: "image/png" });
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/isn't the image its name says/);
    expect(r2.objects.has(key)).toBe(false);
    expect(await rowOf(ticket.fileId)).toBeUndefined();
  });

  it("refuses a .pdf that is really a picture", async () => {
    const { admin, ticket, key } = await arrive("brand_guide", "guide.pdf", "application/pdf", PNG);
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/isn't the kind of file/);
    expect(r2.objects.has(key)).toBe(false);
  });

  it("lets a real PNG, JPEG and PDF through, reading only the first bytes", async () => {
    const png = await arrive("logo", "logo.png", "image/png", PNG);
    await confirmUpload(h.ctx, png.admin.viewer, png.ticket.fileId);
    expect(await rowOf(png.ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/png" });

    r2.objects.clear();
    const jpeg = await arrive("photo", "van.jpg", "image/jpeg", JPEG);
    await confirmUpload(h.ctx, jpeg.admin.viewer, jpeg.ticket.fileId);
    expect(await rowOf(jpeg.ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/jpeg" });

    const pdf = await arrive("brand_guide", "guide.pdf", "application/pdf", PDF);
    await confirmUpload(h.ctx, pdf.admin.viewer, pdf.ticket.fileId);
    expect(await rowOf(pdf.ticket.fileId)).toMatchObject({ status: "ready", contentType: "application/pdf" });

    expect(r2.gets).toEqual([]);
    expect(r2.ranges.length).toBe(3);
    expect(r2.ranges.every((r) => r.start === 0 && r.end < 8192)).toBe(true);
  });

  it("refuses an over-limit size from head() without downloading anything", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    r2.head = async () => ({ sizeBytes: 40 * 1024 * 1024, contentType: null });
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/smaller/);
    expect(r2.gets).toEqual([]);
    expect(r2.ranges).toEqual([]);
    expect(r2.objects.has(key)).toBe(false);
  });

  it("refuses an SVG with a script, an event handler or a javascript link, and keeps a plain one", async () => {
    const bad = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    ];
    for (const svg of bad) {
      r2.objects.clear();
      const { admin, ticket, key } = await arrive("logo", "logo.svg", "image/svg+xml", Buffer.from(svg));
      await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/can't be used/);
      expect(r2.objects.has(key)).toBe(false);
    }
    r2.objects.clear();
    const ok = await arrive("logo", "logo.svg", "image/svg+xml", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><text>one = 1</text></svg>'));
    await confirmUpload(h.ctx, ok.admin.viewer, ok.ticket.fileId);
    expect(await rowOf(ok.ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/svg+xml" });
  });

  it("an upload link used again after confirm can't change the stored file (CodeRabbit #81)", async () => {
    const plain = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><text>one = 1</text></svg>');
    const { admin, ticket, key } = await arrive("logo", "logo.svg", "image/svg+xml", plain);
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    const row = await rowOf(ticket.fileId);
    // The row now names a key the permission slip was never signed for.
    expect(row!.storageKey).not.toBe(key);
    expect(row!.storageKey).toMatch(/\/ready\//);
    // The same link is used again, with a scripted SVG.
    r2.objects.set(key, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'));
    expect(r2.objects.get(row!.storageKey)!.equals(plain)).toBe(true);
  });

  it("a second confirm after a storage hiccup finds the file under its ready key", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    const realGetRange = r2.getRange.bind(r2);
    r2.getRange = async () => {
      throw new Error("503");
    };
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/didn't answer/);
    r2.getRange = realGetRange;
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    const row = await rowOf(ticket.fileId);
    expect(row).toMatchObject({ status: "ready", contentType: "image/png" });
    expect(r2.objects.has(key)).toBe(false);
    expect(r2.objects.has(row!.storageKey)).toBe(true);
  });

  it("refuses an empty upload with a clear message and removes it (CodeRabbit #81)", async () => {
    // The browser declared a size, then sent nothing.
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    r2.objects.set(key, Buffer.alloc(0));
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/empty/);
    expect(r2.objects.has(key)).toBe(false);
    expect(r2.ranges).toEqual([]);
    expect(await rowOf(ticket.fileId)).toBeUndefined();
  });
});

describe("two confirms of one upload at once (CodeRabbit #81, second review)", () => {
  /* Holds the FIRST head() of the upload key until released; later calls go straight through. */
  function holdFirstHead(key: string) {
    const realHead = r2.head.bind(r2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    r2.head = async (k: string) => {
      if (k === key && !held) {
        held = true;
        const seen = await realHead(k);
        await gate;
        return seen;
      }
      return realHead(k);
    };
    return { release, headNow: (k: string) => realHead(k) };
  }
  const entries = async () =>
    (await h.db.select().from(activityLog)).filter((e) => e.action === "intake.file_added").length;

  it("a confirm that looked before the other finished does not delete the ready row", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    // B looks first and finds nothing yet (its head is answered after A is done, when the upload key is gone).
    const realHead = r2.head.bind(r2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    r2.head = async (k: string) => {
      if (k === key && !held) {
        held = true;
        await gate;
      }
      return realHead(k);
    };
    const b = confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    await new Promise((r) => setTimeout(r, 10));
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    expect(r2.objects.has(key)).toBe(false);
    release();
    await b;
    const row = await rowOf(ticket.fileId);
    expect(row).toMatchObject({ status: "ready" });
    expect(r2.objects.has(row!.storageKey)).toBe(true);
    expect(await entries()).toBe(1);
  });

  it("only one confirm copies: the late one stops at the claim and the ready file stays the checked one", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    const { release } = holdFirstHead(key);
    const copies: string[] = [];
    const realCopy = r2.copy.bind(r2);
    r2.copy = async (from: string, to: string) => {
      copies.push(from);
      return realCopy(from, to);
    };
    // B saw the upload; A then runs start to finish.
    const b = confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    await new Promise((r) => setTimeout(r, 10));
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    const ready = (await rowOf(ticket.fileId))!.storageKey;
    // Something else is put behind the upload link before B carries on.
    r2.objects.set(key, HTML);
    release();
    await b;
    expect(copies).toEqual([key]);
    expect(r2.objects.get(ready)!.equals(PNG)).toBe(true);
    expect(await rowOf(ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/png" });
    expect(await entries()).toBe(1);
  });

  it("a confirm of a row that is already ready does nothing", async () => {
    const { admin, ticket } = await arrive("logo", "logo.png", "image/png", PNG);
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    const ranges = r2.ranges.length;
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    expect(r2.ranges.length).toBe(ranges);
    expect(await entries()).toBe(1);
  });
});

describe("a lagging confirm that loses the claim leaves the ready copy alone (Fable's review of #81)", () => {
  it("doesn't remove the checked copy when the reused upload link now holds something it refuses", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    const realHead = r2.head.bind(r2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    r2.head = async (k: string) => {
      if (k === key && !held) {
        held = true;
        await gate;
      }
      return realHead(k);
    };
    // B reads the row first and waits; A runs start to finish.
    const b = confirmUpload(h.ctx, admin.viewer, ticket.fileId).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    const ready = (await rowOf(ticket.fileId))!.storageKey;
    // The upload link is used again, with an empty file: B will refuse it.
    r2.objects.set(key, Buffer.alloc(0));
    release();
    await b;
    expect(r2.objects.get(ready)?.equals(PNG)).toBe(true);
    expect(await rowOf(ticket.fileId)).toMatchObject({ status: "ready" });
  });

  // Fable's re-review: the same, while the other confirm is still checking its claimed copy (the row still "pending").
  it("doesn't delete the row another confirm has claimed and is still checking", async () => {
    const { admin, ticket, key } = await arrive("logo", "logo.png", "image/png", PNG);
    const realHead = r2.head.bind(r2);
    const realRange = r2.getRange.bind(r2);
    let releaseB!: () => void;
    let releaseA!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    const gateA = new Promise<void>((r) => (releaseA = r));
    let heldB = false;
    let heldA = false;
    r2.head = async (k: string) => {
      if (k === key && !heldB) {
        heldB = true;
        await gateB;
      }
      return realHead(k);
    };
    r2.getRange = async (k: string, start: number, end: number) => {
      if (k.includes("/ready/") && !heldA) {
        heldA = true;
        await gateA;
      }
      return realRange(k, start, end);
    };
    // B reads the row (still on the upload key) and waits.
    const b = confirmUpload(h.ctx, admin.viewer, ticket.fileId).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    // A claims, copies, and is held while checking the copy.
    const a = confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    await vi.waitFor(() => expect(heldA).toBe(true));
    // The upload link is used again with an empty file; B refuses it.
    r2.objects.set(key, Buffer.alloc(0));
    releaseB();
    await b;
    expect(await rowOf(ticket.fileId)).toMatchObject({ status: "pending" });
    releaseA();
    await a;
    const row = await rowOf(ticket.fileId);
    expect(row).toMatchObject({ status: "ready" });
    expect(r2.objects.get(row!.storageKey)?.equals(PNG)).toBe(true);
  });
});
