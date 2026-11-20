/*
  The shape a server action hands back to the form that called it.

  Kept apart from server-context.ts, which opens a database connection: a
  client component importing this must not drag the database layer into the
  browser bundle.
*/
export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  notice?: string;
  secret?: { label: string; value: string };
}

export const emptyActionState: ActionState = {};
