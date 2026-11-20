"use client";

import { useEffect } from "react";

/*
  What on the current page has not been saved, if anything.

  The top bar's Sign out needs to know, but it lives in the layout and
  cannot see inside the page. So a screen with a form reports its unsaved
  work here while it is dirty, as a phrase that completes "You have unsaved
  changes in ..." - for example "the Business section of Pat Rivera's
  intake". Sign out asks first only when something is registered.

  One entry per screen at a time is enough: only one editable form is on
  screen at once.
*/

let current: string | null = null;

export function unsavedChanges(): string | null {
  return current;
}

/** Registers while `description` is set, and clears on change or unmount. */
export function useUnsavedChanges(description: string | null): void {
  useEffect(() => {
    if (!description) return;
    current = description;
    return () => {
      if (current === description) current = null;
    };
  }, [description]);
}

/** Only for tests. */
export function resetUnsavedChangesForTesting(): void {
  current = null;
}
