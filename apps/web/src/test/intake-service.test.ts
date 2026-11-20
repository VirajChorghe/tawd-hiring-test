import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gap 11: real isHeic (detects by bytes); the decode is stubbed so no WASM or
// fixture is needed. Only HEIC bytes trigger it, so other upload tests are
// unaffected. The real heic-convert decode is verified separately.
vi.mock("@tawd/core/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tawd/core/images")>()),
  heicToJpeg: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
}));

import { activityLog, intakeFile, project, projectIntake } from "@tawd/core/schema";
import { verifyActivityChain } from "@tawd/core/activity";
import {
  setStorageForTesting,
  type FileStorage,
  type StoredObject,
} from "@tawd/core/intake/storage";
import {
  IntakeError,
  confirmUpload,
  diffSection,
  loadIntake,
  removeFile,
  requestUpload,
  saveIntakeSection,
  setFileCaption,
} from "@tawd/core/intake/service";
import { PermissionError } from "@tawd/core/permissions";
import { GateError, createProject, updateProject } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

/*
  A stand-in for Cloudflare.

  Storage sits behind an interface precisely so these tests never reach the
  network: they can then assert the things that matter, such as a file being
  deleted from the bucket when it turns out to be too big.
*/
function realBytesFor(contentType: string): Buffer {
  if (contentType === "image/jpeg") return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 1)]);
  if (contentType === "application/pdf") return Buffer.from("%PDF-1.7\n" + "x".repeat(24));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
}

class FakeStorage implements FileStorage {
  objects = new Map<string, StoredObject>();
  bodies = new Map<string, Buffer>();
  removed: string[] = [];
  signedUploads: string[] = [];

  async signUpload(key: string): Promise<string> {
    this.signedUploads.push(key);
    return `https://fake-r2.test/${key}?upload=1`;
  }

  async signDownload(key: string): Promise<string> {
    return `https://fake-r2.test/${key}?download=1`;
  }

  async head(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
    this.removed.push(key);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.bodies.set(key, body);
    this.objects.set(key, { sizeBytes: body.length, contentType });
  }

  async get(key: string): Promise<Buffer | null> {
    return this.bodies.get(key) ?? null;
  }

  async copy(from: string, to: string): Promise<void> {
    const object = this.objects.get(from);
    if (!object) throw new Error(`NoSuchKey: ${from}`);
    this.objects.set(to, { ...object });
    const body = this.bodies.get(from);
    if (body) this.bodies.set(to, Buffer.from(body));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer | null> {
    return this.bodies.get(key)?.subarray(start, end + 1) ?? null;
  }

  /**
   * Pretends the browser finished uploading. The size is what storage reports;
   * the bytes are a real file's first bytes for the type (confirmUpload reads
   * them, F-041), unless a test supplies its own.
   */
  arrive(key: string, sizeBytes: number, contentType = "image/png", body?: Buffer) {
    this.objects.set(key, { sizeBytes, contentType });
    this.bodies.set(key, body ?? realBytesFor(contentType));
  }
}

let h: Harness;
let storage: FakeStorage;

beforeEach(async () => {
  h = await createHarness();
  storage = new FakeStorage();
  setStorageForTesting(storage);
});

afterEach(async () => {
  setStorageForTesting(null);
  await h.close();
});

const lane1 = {
  clientName: "Sacramento Drain Pros",
  trade: "plumbing" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "intake" as const,
  memberUserIds: [] as string[],
};

async function setup() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, {
    email: "pm@velocitymedialab.com",
    roles: ["pm"],
  });
  const seo = await seedUser(h, admin.viewer, {
    email: "seo@velocitymedialab.com",
    roles: ["seo"],
  });
  const projectId = await createProject(h.ctx, admin.viewer, lane1);
  return { admin, pm, seo, projectId };
}

/** Answers every required question, so the gate would let the project out. */
async function completeTheIntake(
  actor: Awaited<ReturnType<typeof setup>>["admin"]["viewer"],
  projectId: string,
) {
  await saveIntakeSection(h.ctx, actor, projectId, "business", {
    name: "Sacramento Drain Pros",
    phone: "916-555-0142",
    streetAddress: "1 Main Street",
    licenseNumbers: ["C36-123456"],
    yearFounded: 2009,
    googleBusinessProfileUrl: "https://maps.google.com/example",
  });
  await saveIntakeSection(h.ctx, actor, projectId, "services", {
    items: [{ id: "s1", name: "Drain cleaning", description: "" }],
    mainServiceId: "s1",
  });
  await saveIntakeSection(h.ctx, actor, projectId, "serviceAreas", {
    cities: ["Sacramento"],
    wantsIndividualCityPages: false,
  });
  await saveIntakeSection(h.ctx, actor, projectId, "website", { noCurrentWebsite: true });

  const ticket = await requestUpload(
    h.ctx,
    actor,
    projectId,
    "logo",
    "logo.png",
    "image/png",
    120_000,
  );
  storage.arrive(storage.signedUploads.at(-1)!, 120_000);
  await confirmUpload(h.ctx, actor, ticket.fileId);
}

describe("who can edit the intake", () => {
  it("lets a PM edit", async () => {
    const { pm, projectId } = await setup();
    await expect(
      saveIntakeSection(h.ctx, pm.viewer, projectId, "business", {
        name: "Test",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses an SEO or Content person", async () => {
    const { seo, projectId } = await setup();
    await expect(
      saveIntakeSection(h.ctx, seo.viewer, projectId, "business", {
        name: "Test",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("still lets everybody read it", async () => {
    const { admin, seo, projectId } = await setup();
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
    });

    const loaded = await loadIntake(h.db, seo.viewer, projectId);
    expect(loaded?.data.business.name).toBe("Sacramento Drain Pros");
  });

  it("refuses a disabled account outright", async () => {
    const { seo, projectId } = await setup();
    await expect(
      loadIntake(h.db, { ...seo.viewer, isDisabled: true }, projectId),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("saving a section", () => {
  it("stores the answers and reads them back", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
      phone: "916-555-0142",
      yearFounded: "2009",
      licenseNumbers: ["C36-123456", ""],
    });

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.data.business.name).toBe("Sacramento Drain Pros");
    // A number typed into a form arrives as text.
    expect(loaded?.data.business.yearFounded).toBe(2009);
    // Blank rows in a list input are dropped rather than stored.
    expect(loaded?.data.business.licenseNumbers).toEqual(["C36-123456"]);
  });

  it("leaves the other sections alone", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
    });
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "extras", {
      currentOffers: "Ten percent off in November",
    });

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.data.business.name).toBe("Sacramento Drain Pros");
    expect(loaded?.data.extras.currentOffers).toBe("Ten percent off in November");
  });

  it("keeps the rest when one stored answer breaks a later rule (13 October 2026)", async () => {
    const { admin, projectId } = await setup();
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", { name: "Sacramento Drain Pros", city: "Sacramento" });
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "extras", { currentOffers: "Ten percent off" });
    // As if a later release tightened the rule for a stored answer.
    const [row] = await h.db.select().from(projectIntake).where(eq(projectIntake.projectId, projectId));
    const stored = row!.data as Record<string, Record<string, unknown>>;
    await h.db
      .update(projectIntake)
      .set({ data: { ...stored, business: { ...stored.business, googleBusinessProfileUrl: "not-a-web-address" } } })
      .where(eq(projectIntake.projectId, projectId));

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.data.business.name).toBe("Sacramento Drain Pros");
    expect(loaded?.data.business.googleBusinessProfileUrl).toBe("");
    expect(loaded?.data.extras.currentOffers).toBe("Ten percent off");

    // Saving another section never writes the blank over the stored answer.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "extras", { currentOffers: "Fifteen percent off" });
    const [after] = await h.db.select().from(projectIntake).where(eq(projectIntake.projectId, projectId));
    const data = after!.data as Record<string, Record<string, unknown>>;
    expect(data.business!.googleBusinessProfileUrl).toBe("not-a-web-address");
    expect(data.business!.name).toBe("Sacramento Drain Pros");
    expect(data.extras!.currentOffers).toBe("Fifteen percent off");
  });

  it("refuses an answer that is not valid", async () => {
    const { admin, projectId } = await setup();

    await expect(
      saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
        googleBusinessProfileUrl: "not-a-web-address",
      }),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it("reads an empty intake for a project nobody has touched", async () => {
    const { admin, projectId } = await setup();

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.data.business.name).toBe("");
    expect(loaded?.completeness.isComplete).toBe(false);
  });

  it("returns null for a project that does not exist", async () => {
    const { admin } = await setup();
    const loaded = await loadIntake(
      h.db,
      admin.viewer,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(loaded).toBeNull();
  });
});

describe("what a save writes to the log", () => {
  it("records only the fields that actually changed", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
      phone: "916-555-0142",
    });
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
      phone: "916-555-0199",
    });

    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.updated"))
      .orderBy(activityLog.seq);

    expect(entries).toHaveLength(2);

    // The log records the numbers as saved: (916) 555-0142, however they were typed (6 October 2026).
    const second = entries[1]!;
    expect(second.valueBefore).toEqual({
      section: "business",
      phone: "(916) 555-0142",
    });
    expect(second.valueAfter).toEqual({
      section: "business",
      phone: "(916) 555-0199",
    });
  });

  it("writes nothing at all when nothing changed", async () => {
    const { admin, projectId } = await setup();

    const values = { name: "Sacramento Drain Pros", phone: "916-555-0142" };
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", values);
    const second = await saveIntakeSection(
      h.ctx,
      admin.viewer,
      projectId,
      "business",
      values,
    );

    expect(second.changedPaths).toEqual([]);

    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.updated"));
    expect(entries).toHaveLength(1);
  });

  it("names who made the change", async () => {
    const { pm, projectId } = await setup();

    await saveIntakeSection(h.ctx, pm.viewer, projectId, "business", {
      name: "Sacramento Drain Pros",
    });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.updated"));

    expect(entry?.actorEmail).toBe("pm@velocitymedialab.com");
    expect(entry?.ipAddress).toBe("203.0.113.10");
  });

  it("treats a list as one change rather than one per position", () => {
    const change = diffSection(
      { cities: ["Sacramento"] },
      { cities: ["Sacramento", "Elk Grove"] },
    );

    expect(change.changedPaths).toEqual(["cities"]);
    expect(change.after).toEqual({ cities: ["Sacramento", "Elk Grove"] });
  });

  it("keeps the log verifiable through a whole intake", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    const result = await verifyActivityChain(h.db);
    expect(result.valid).toBe(true);
  });
});

describe("uploading a file", () => {
  it("hands back a link and records the file once it arrives", async () => {
    const { admin, projectId } = await setup();

    const ticket = await requestUpload(
      h.ctx,
      admin.viewer,
      projectId,
      "logo",
      "Our Logo!.png",
      "image/png",
      120_000,
    );

    expect(ticket.uploadUrl).toContain("upload=1");

    const key = storage.signedUploads.at(-1)!;
    // Grouped by project, and the awkward characters are gone.
    expect(key).toContain(`projects/${projectId}/logo/`);
    expect(key).toContain("our-logo-.png");

    storage.arrive(key, 120_000);
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.files).toHaveLength(1);
    expect(loaded?.files[0]?.sizeBytes).toBe(120_000);
  });

  it("refuses the wrong type before signing anything", async () => {
    const { admin, projectId } = await setup();

    await expect(
      requestUpload(
        h.ctx,
        admin.viewer,
        projectId,
        "logo",
        "virus.exe",
        "application/x-msdownload",
        1000,
      ),
    ).rejects.toBeInstanceOf(IntakeError);

    expect(storage.signedUploads).toHaveLength(0);
  });

  it("deletes a file that turns out to be bigger than it claimed", async () => {
    const { admin, projectId } = await setup();

    const ticket = await requestUpload(
      h.ctx,
      admin.viewer,
      projectId,
      "logo",
      "logo.png",
      "image/png",
      100_000,
    );

    // The browser under-reported the size. The real file is 40 MB.
    const key = storage.signedUploads.at(-1)!;
    storage.arrive(key, 40 * 1024 * 1024);

    await expect(
      confirmUpload(h.ctx, admin.viewer, ticket.fileId),
    ).rejects.toBeInstanceOf(IntakeError);

    expect(storage.removed).toContain(key);

    const rows = await h.db
      .select()
      .from(intakeFile)
      .where(eq(intakeFile.projectId, projectId));
    expect(rows).toHaveLength(0);
  });

  it("keeps the upload's record when storage doesn't answer (13 October 2026)", async () => {
    const { admin, projectId } = await setup();
    const ticket = await requestUpload(h.ctx, admin.viewer, projectId, "logo", "logo.png", "image/png", 100_000);
    storage.head = async () => {
      throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    };
    await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow("File storage didn't answer");
    expect(await h.db.select().from(intakeFile).where(eq(intakeFile.projectId, projectId))).toHaveLength(1);
  });

  it("tidies up when the upload never arrives", async () => {
    const { admin, projectId } = await setup();

    const ticket = await requestUpload(
      h.ctx,
      admin.viewer,
      projectId,
      "photo",
      "crew.jpg",
      "image/jpeg",
      500_000,
    );

    // Nothing was uploaded, so the object is not there.
    await expect(
      confirmUpload(h.ctx, admin.viewer, ticket.fileId),
    ).rejects.toBeInstanceOf(IntakeError);

    const rows = await h.db.select().from(intakeFile);
    expect(rows).toHaveLength(0);
  });

  it("hides an upload that never finished", async () => {
    const { admin, projectId } = await setup();

    await requestUpload(
      h.ctx,
      admin.viewer,
      projectId,
      "photo",
      "crew.jpg",
      "image/jpeg",
      500_000,
    );

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.files).toHaveLength(0);
  });

  it("will not take a second logo", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    await expect(
      requestUpload(
        h.ctx,
        admin.viewer,
        projectId,
        "logo",
        "another.png",
        "image/png",
        1000,
      ),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it("refuses an SEO person", async () => {
    const { seo, projectId } = await setup();

    await expect(
      requestUpload(
        h.ctx,
        seo.viewer,
        projectId,
        "photo",
        "crew.jpg",
        "image/jpeg",
        1000,
      ),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("captions and removal", () => {
  it("records a caption change with both values", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    const fileId = loaded!.files[0]!.id;

    await setFileCaption(h.ctx, admin.viewer, fileId, "The company logo");

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.file_captioned"));

    expect(entry?.valueBefore).toMatchObject({ caption: "" });
    expect(entry?.valueAfter).toMatchObject({ caption: "The company logo" });
  });

  it("removes the file from storage as well as the database", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    const fileId = loaded!.files[0]!.id;
    const key = storage.signedUploads.at(-1)!;

    await removeFile(h.ctx, admin.viewer, fileId);

    expect(storage.removed).toContain(key);
    expect(storage.objects.has(key)).toBe(false);

    const after = await loadIntake(h.db, admin.viewer, projectId);
    expect(after?.files).toHaveLength(0);
  });

  it("keeps the removed file in the log, since the row is gone", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    await removeFile(h.ctx, admin.viewer, loaded!.files[0]!.id);

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.file_removed"));

    expect(entry?.valueBefore).toMatchObject({
      kind: "logo",
      fileName: "logo.png",
    });
  });

  it("makes the logo requirement unmet again once it is removed", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    const before = await loadIntake(h.db, admin.viewer, projectId);
    expect(before?.completeness.isComplete).toBe(true);

    await removeFile(h.ctx, admin.viewer, before!.files[0]!.id);

    const after = await loadIntake(h.db, admin.viewer, projectId);
    expect(after?.completeness.missing.map((m) => m.key)).toContain(
      "brand.logo",
    );
  });
});

/*
  DESIGN.md moved captions from saving on blur to saving with the Photos
  section. The behavior underneath is unchanged, which is what these check:
  the same helper, the same log entry, one per caption that actually moved.
*/
describe("captions save with the Photos section", () => {
  it("writes one entry per caption that actually changed", async () => {
    const { admin, projectId } = await setup();

    const first = await requestUpload(
      h.ctx, admin.viewer, projectId, "photo", "van.jpg", "image/jpeg", 400_000,
    );
    storage.arrive(storage.signedUploads.at(-1)!, 400_000, "image/jpeg");
    await confirmUpload(h.ctx, admin.viewer, first.fileId);

    const second = await requestUpload(
      h.ctx, admin.viewer, projectId, "photo", "team.jpg", "image/jpeg", 400_000,
    );
    storage.arrive(storage.signedUploads.at(-1)!, 400_000, "image/jpeg");
    await confirmUpload(h.ctx, admin.viewer, second.fileId);

    // One caption changes, the other is saved with the value it already had.
    await setFileCaption(h.ctx, admin.viewer, first.fileId, "Van outside the shop");
    await setFileCaption(h.ctx, admin.viewer, second.fileId, "");

    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "intake.file_captioned"));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.valueAfter).toMatchObject({
      fileName: "van.jpg",
      caption: "Van outside the shop",
    });
  });

  it("keeps the notes and the captions independent", async () => {
    const { admin, projectId } = await setup();

    const ticket = await requestUpload(
      h.ctx, admin.viewer, projectId, "photo", "van.jpg", "image/jpeg", 400_000,
    );
    storage.arrive(storage.signedUploads.at(-1)!, 400_000, "image/jpeg");
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "photos", {
      notes: "The client likes the van shot best.",
    });
    await setFileCaption(h.ctx, admin.viewer, ticket.fileId, "Van outside the shop");

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.data.photos.notes).toBe("The client likes the van shot best.");
    expect(loaded?.files[0]?.caption).toBe("Van outside the shop");
  });
});

describe("the gate, from the project side", () => {
  it("refuses to move an incomplete project to Mockups", async () => {
    const { admin, projectId } = await setup();

    await expect(
      updateProject(h.ctx, admin.viewer, projectId, {
        ...lane1,
        status: "mockups",
      }),
    ).rejects.toBeInstanceOf(GateError);

    const [row] = await h.db
      .select()
      .from(project)
      .where(eq(project.id, projectId));
    expect(row?.status).toBe("intake");
  });

  it("refuses to let it skip ahead to Build either", async () => {
    const { admin, projectId } = await setup();

    await expect(
      updateProject(h.ctx, admin.viewer, projectId, {
        ...lane1,
        status: "build",
      }),
    ).rejects.toBeInstanceOf(GateError);
  });

  it("allows pausing an incomplete project", async () => {
    const { admin, projectId } = await setup();

    await expect(
      updateProject(h.ctx, admin.viewer, projectId, {
        ...lane1,
        status: "paused",
      }),
    ).resolves.toBeUndefined();
  });

  it("lets a complete project through with no override", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    await updateProject(h.ctx, admin.viewer, projectId, {
      ...lane1,
      status: "mockups",
    });

    const [row] = await h.db
      .select()
      .from(project)
      .where(eq(project.id, projectId));
    expect(row?.status).toBe("mockups");

    const overrides = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.gate_overridden"));
    expect(overrides).toHaveLength(0);
  });

  it("lets a PM continue without the missing items, and logs what was missing", async () => {
    const { admin, pm, projectId } = await setup();

    // The current website is the one item nothing skips (30 September 2026): answered here, the rest stays missing.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });

    await updateProject(h.ctx, pm.viewer, projectId, { ...lane1, status: "mockups" }, { continueWithoutMissing: true });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.gate_overridden"));
    expect(entry!.actorEmail).toBe(pm.viewer.email);
    expect((entry!.valueBefore as { missing: string[] }).missing.length).toBeGreaterThan(0);
    expect((entry!.valueAfter as { reason: string }).reason).toBe("Continued without these");
  });

  it("still asks for the explicit choice when items are missing", async () => {
    const { pm, projectId } = await setup();
    await expect(
      updateProject(h.ctx, pm.viewer, projectId, { ...lane1, status: "mockups" }),
    ).rejects.toBeInstanceOf(GateError);
  });

  it("lets an admin override, and records the reason and what was skipped", async () => {
    const { admin, projectId } = await setup();

    // The current website is the one item nothing skips (30 September 2026): answered here, the rest stays missing.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    const reason = "Client is away; license number follows on Monday.";

    await updateProject(
      h.ctx,
      admin.viewer,
      projectId,
      { ...lane1, status: "mockups" },
      { overrideReason: reason },
    );

    const [row] = await h.db
      .select()
      .from(project)
      .where(eq(project.id, projectId));
    expect(row?.status).toBe("mockups");

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.gate_overridden"));

    expect(entry?.valueAfter).toMatchObject({ reason, status: "mockups" });

    const before = entry?.valueBefore as { missing: string[] };
    expect(before.missing).toContain("Business name");
    expect(before.missing.length).toBeGreaterThan(3);
  });

  it("records the override before the status change it allowed", async () => {
    const { admin, projectId } = await setup();

    // The current website is the one item nothing skips (30 September 2026): answered here, the rest stays missing.
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });

    await updateProject(
      h.ctx,
      admin.viewer,
      projectId,
      { ...lane1, status: "mockups" },
      { overrideReason: "Client is away; the rest follows on Monday." },
    );

    const entries = await h.db
      .select()
      .from(activityLog)
      .orderBy(activityLog.seq);

    const overrideAt = entries.findIndex(
      (e) => e.action === "project.gate_overridden",
    );
    const statusAt = entries.findIndex(
      (e) => e.action === "project.status_changed",
    );

    expect(overrideAt).toBeGreaterThan(-1);
    expect(overrideAt).toBeLessThan(statusAt);
  });

  it("ignores an override reason on a move the gate does not cover", async () => {
    const { admin, projectId } = await setup();
    await completeTheIntake(admin.viewer, projectId);

    await updateProject(h.ctx, admin.viewer, projectId, {
      ...lane1,
      status: "mockups",
    });
    await updateProject(
      h.ctx,
      admin.viewer,
      projectId,
      { ...lane1, status: "content" },
      { overrideReason: "Not needed for this move at all, but harmless." },
    );

    const overrides = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.gate_overridden"));
    expect(overrides).toHaveLength(0);
  });
});

describe("the tier warning, from the project side", () => {
  it("appears on a Starter project with too many services", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "services", {
      items: Array.from({ length: 7 }, (_, i) => ({
        id: `s${i}`,
        name: `Service ${i}`,
        description: "",
      })),
      mainServiceId: "s0",
    });

    const loaded = await loadIntake(h.db, admin.viewer, projectId);
    expect(loaded?.tierWarning?.needsAtLeast).toBe("growth");
  });

  it("goes away once the project is moved to Growth", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "serviceAreas", {
      cities: ["Sacramento", "Elk Grove"],
      wantsIndividualCityPages: true,
    });

    expect(
      (await loadIntake(h.db, admin.viewer, projectId))?.tierWarning,
    ).not.toBeNull();

    await updateProject(h.ctx, admin.viewer, projectId, {
      ...lane1,
      tier: "growth",
    });

    expect(
      (await loadIntake(h.db, admin.viewer, projectId))?.tierWarning,
    ).toBeNull();
  });

  it("does not change the tier by itself", async () => {
    const { admin, projectId } = await setup();

    await saveIntakeSection(h.ctx, admin.viewer, projectId, "services", {
      items: Array.from({ length: 9 }, (_, i) => ({
        id: `s${i}`,
        name: `Service ${i}`,
        description: "",
      })),
      mainServiceId: "s0",
    });

    const [row] = await h.db
      .select()
      .from(project)
      .where(eq(project.id, projectId));
    expect(row?.tier).toBe("starter");
  });
});

describe("a HEIC upload (gap 11)", () => {
  // A minimal HEIC header: ftyp box with the "heic" major brand.
  const HEIC = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic", "ascii"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1", "ascii"),
    Buffer.alloc(32, 9),
  ]);

  /*
    CodeRabbit on PR #75 (12 November 2026), checked against the code
    first. A file the browser gave no type for is let in by its NAME
    (files.ts); before this, nothing then looked at its bytes unless they
    were HEIC, so "photo.heic" holding anything at all became a ready
    image/heic, and a failed read went straight to ready as well.
  */
  describe("a file let in by its name, because the browser gave no type", () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 1)]);
    const upload = async (kind: "photo" | "logo", name: string, body: Buffer | null, seeded?: Awaited<ReturnType<typeof setup>>) => {
      const { admin, projectId } = seeded ?? (await setup());
      const ticket = await requestUpload(h.ctx, admin.viewer, projectId, kind, name, "", 1000);
      const key = storage.signedUploads.at(-1)!;
      // The browser's PUT, with the empty type it reported.
      if (body) await storage.put(key, body, "");
      else storage.arrive(key, 1000, "");
      return { admin, ticket, key, seeded: seeded ?? { admin, projectId } as Awaited<ReturnType<typeof setup>> };
    };
    const rowOf = async (id: string) => (await h.db.select().from(intakeFile).where(eq(intakeFile.id, id)))[0];

    it("is refused and removed when its bytes are not an image", async () => {
      const { admin, ticket, key } = await upload("photo", "photo.heic", Buffer.from("MZ this is a program, not a photo".padEnd(64, ".")));
      await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/isn't the image its name says/);
      expect(await rowOf(ticket.fileId)).toBeUndefined();
      expect(storage.removed).toContain(key);
    });

    it("is kept with the type its bytes show", async () => {
      const png = await upload("logo", "logo.png", PNG);
      await confirmUpload(h.ctx, png.admin.viewer, png.ticket.fileId);
      expect(await rowOf(png.ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/png" });

      const jpeg = await upload("photo", "patio.png", JPEG, png.seeded);
      await confirmUpload(h.ctx, jpeg.admin.viewer, jpeg.ticket.fileId);
      expect(await rowOf(jpeg.ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/jpeg" });
    });

    it("stays waiting and asks for a retry when its bytes can't be read", async () => {
      const { admin, ticket } = await upload("photo", "IMG_1126.HEIC", HEIC);
      storage.get = async () => {
        throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      };
      await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow("File storage didn't answer");
      expect(await rowOf(ticket.fileId)).toMatchObject({ status: "pending" });
    });

    it("is still converted when it is a HEIC", async () => {
      const { admin, ticket } = await upload("photo", "IMG_1126.HEIC", HEIC);
      await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
      expect(await rowOf(ticket.fileId)).toMatchObject({ status: "ready", contentType: "image/jpeg", fileName: "IMG_1126.jpg" });
    });
  });

  it("converts a HEIC to JPEG by its bytes even when it arrives as photo.jpg, and keeps the original", async () => {
    const { admin, projectId } = await setup();
    const ticket = await requestUpload(
      h.ctx,
      admin.viewer,
      projectId,
      "photo",
      "photo.jpg", // a HEIC the phone/browser labelled .jpg
      "image/jpeg",
      HEIC.length,
    );
    const key = storage.signedUploads.at(-1)!;
    // The browser's upload: real HEIC bytes stored under the key.
    await storage.put(key, HEIC, "image/jpeg");

    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);

    const [row] = await h.db.select().from(intakeFile).where(eq(intakeFile.id, ticket.fileId));
    expect(row?.status).toBe("ready");
    expect(row?.contentType).toBe("image/jpeg");
    expect(row?.fileName).toBe("photo.jpg");
    expect(row?.sizeBytes).toBe(7);
    // The usable file is now the JPEG; the HEIC original is kept beside it.
    // (confirm moved it to a ready key, so the upload link can't change it afterwards)
    const finalKey = row!.storageKey;
    expect(finalKey).not.toBe(key);
    expect(storage.bodies.get(finalKey)!.equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(true);
    expect(storage.bodies.get(`${finalKey}.heic-original`)!.equals(HEIC)).toBe(true);
  });

  // Fable's re-review of #81: a second confirm (a second click) that reads the photo after the first has written its JPEG over it.
  it("a second confirm of the same photo doesn't convert the first one's JPEG again or lose the original", async () => {
    const { admin, projectId } = await setup();
    const ticket = await requestUpload(h.ctx, admin.viewer, projectId, "photo", "IMG_1.HEIC", "image/heic", HEIC.length);
    await storage.put(storage.signedUploads.at(-1)!, HEIC, "image/heic");
    // B claims and copies, then is held at its first read of the ready copy (it will see HEIC).
    const realRange = storage.getRange.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    storage.getRange = async (key: string, start: number, end: number) => {
      const bytes = await realRange(key, start, end);
      if (!held && key.includes("/ready/")) {
        held = true;
        await gate;
      }
      return bytes;
    };
    const b = confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    await vi.waitFor(() => expect(held).toBe(true));
    // A runs start to finish: converts, keeps the original, marks it ready.
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    release();
    await b;
    const [row] = await h.db.select().from(intakeFile).where(eq(intakeFile.id, ticket.fileId));
    expect(row).toMatchObject({ status: "ready", contentType: "image/jpeg" });
    expect(storage.bodies.get(`${row!.storageKey}.heic-original`)!.equals(HEIC)).toBe(true);
    expect(storage.bodies.has(row!.storageKey)).toBe(true);
  });
});
