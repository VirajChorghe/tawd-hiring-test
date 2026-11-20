import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_SLOTS, SLOT_GIVE_UP_MS, SLOT_WAIT_MS, limitPages, pageSlots } from "../../../worker/src/locked-context";

/* C10 (audit F-037, Jason: keep the speed, add the cap): at most PAGE_SLOTS pages open at once across every context. */

function fakeContext() {
  const context = Object.assign(new EventEmitter(), {
    newPage: async () => {
      const page = new EventEmitter() as EventEmitter & { close: () => void };
      page.close = () => page.emit("close");
      return page;
    },
  });
  return limitPages(context as never) as unknown as EventEmitter & { newPage: () => Promise<EventEmitter & { close: () => void }> };
}

describe("the page cap", () => {
  it("lets PAGE_SLOTS pages open, holds the next until one closes, and frees a closed context's pages", async () => {
    expect(PAGE_SLOTS).toBe(3);
    const a = fakeContext();
    const pages = await Promise.all(Array.from({ length: PAGE_SLOTS }, () => a.newPage()));
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS, waiting: 0 });

    let fourth: unknown = null;
    const pending = fakeContext().newPage().then((p) => (fourth = p));
    await new Promise((r) => setTimeout(r, 20));
    expect(fourth).toBeNull();
    expect(pageSlots().waiting).toBe(1);

    pages[0]!.close();
    await pending;
    expect(fourth).not.toBeNull();
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS, waiting: 0 });

    // Closing a context gives back the slots of the pages it still had open (each only once).
    a.emit("close");
    pages[1]!.close();
    expect(pageSlots().open).toBe(1);
    (fourth as { close: () => void }).close();
    expect(pageSlots().open).toBe(0);
  });
});

type Slotted = { close: () => void };

describe("a slot given back goes to the waiter, not to whoever asks next (CodeRabbit #81)", () => {
  it("never lets the open count pass the cap when a page closes and another caller asks at once", async () => {
    const a = fakeContext();
    const pages = await Promise.all(Array.from({ length: PAGE_SLOTS }, () => a.newPage()));
    let waiter: Slotted | null = null;
    const first = fakeContext().newPage().then((p) => (waiter = p));
    await new Promise((r) => setTimeout(r, 10));
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS, waiting: 1 });

    let latecomer: Slotted | null = null;
    let highest = 0;
    const watch = setInterval(() => (highest = Math.max(highest, pageSlots().open)), 0);
    pages[0]!.close();
    // Straight after the close, before the waiter has run: another caller asks.
    const second = fakeContext().newPage().then((p) => (latecomer = p));
    highest = Math.max(highest, pageSlots().open);
    await first;
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(watch);

    expect(highest).toBeLessThanOrEqual(PAGE_SLOTS);
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS, waiting: 1 });
    expect(latecomer).toBeNull();
    // Tidy up: everything closes and the latecomer gets its turn.
    pages[1]!.close();
    await second;
    for (const p of [pages[2]!, waiter!, latecomer!]) p.close();
    expect(pageSlots()).toEqual({ open: 0, waiting: 0 });
  });
});

describe("the wait limit is bounded (CodeRabbit #81)", () => {
  afterEach(() => vi.useRealTimers());

  it("lets at most PAGE_SLOTS extra pages through after the wait, then keeps waiting", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = await Promise.all(Array.from({ length: PAGE_SLOTS }, () => fakeContext().newPage()));
    const opened: Slotted[] = [];
    // Twice as many callers as there are extra places.
    for (let i = 0; i < PAGE_SLOTS * 2; i++) void fakeContext().newPage().then((p) => opened.push(p));
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS + 1);
    expect(opened.length).toBe(PAGE_SLOTS);
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS * 2, waiting: PAGE_SLOTS });

    // Another wait period: still the ceiling, and the log says so.
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS * 2);
    expect(pageSlots().open).toBe(PAGE_SLOTS * 2);
    expect(opened.length).toBe(PAGE_SLOTS);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("still waiting"))).toBe(true);

    // A page closing above the cap shrinks the count; it is not handed on while the count is over the cap.
    held[0]!.close();
    expect(pageSlots().open).toBe(PAGE_SLOTS * 2 - 1);
    expect(opened.length).toBe(PAGE_SLOTS);

    // Close the rest: waiters are served only as the count falls to the cap.
    for (const p of [...held.slice(1), ...opened]) p.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(opened.length).toBe(PAGE_SLOTS * 2);
    for (const p of opened) p.close();
    expect(pageSlots()).toEqual({ open: 0, waiting: 0 });
    warn.mockRestore();
  });
});

describe("a waiter at the ceiling gives up in the end (CodeRabbit #81, second review)", () => {
  afterEach(() => vi.useRealTimers());

  it("fails the caller after SLOT_GIVE_UP_MS instead of waiting forever, leaves the queue, and never passes the ceiling", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = await Promise.all(Array.from({ length: PAGE_SLOTS }, () => fakeContext().newPage()));
    const escaped: Slotted[] = [];
    for (let i = 0; i < PAGE_SLOTS; i++) void fakeContext().newPage().then((p) => escaped.push(p));
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS + 1);
    expect(pageSlots().open).toBe(PAGE_SLOTS * 2);

    let failure: unknown = null;
    void fakeContext().newPage().catch((e: unknown) => (failure = e));
    await vi.advanceTimersByTimeAsync(SLOT_GIVE_UP_MS - SLOT_WAIT_MS);
    expect(failure).toBeNull();
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS * 2, waiting: 1 });

    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS + 1);
    expect(String(failure)).toContain("No browser page came free");
    expect(pageSlots()).toEqual({ open: PAGE_SLOTS * 2, waiting: 0 });

    for (const p of [...held, ...escaped]) p.close();
    expect(pageSlots()).toEqual({ open: 0, waiting: 0 });
    warn.mockRestore();
  });
});
