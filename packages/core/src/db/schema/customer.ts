import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/*
  Customer accounts (Part 2, task 1, 3 November 2026).

  Customers of the self-serve app (build.tawdwebsites.com) live here and only
  here, never in the team's `user` table. Jason chose separate tables over a
  "customer" role beside the team roles (the brief's wording) for isolation:
  the two front doors never share a login or a session, and no team-app check
  can be fooled by a customer row because the team app never reads this table.
  See docs/plans/part2-task1-customer-accounts.md.

  The columns follow what Better Auth expects of its user table (property
  names camelCase, columns snake_case, like auth.ts) plus its phone-number
  plugin's two fields, so task 2 can point a separate Better Auth instance at
  this table by renaming its model. The customer's session, account and
  verification tables arrive with that sign-in in task 2.
*/
export const customer = pgTable("customer", {
  id: text("id").primaryKey(),
  // The customer's first name, as given on the Verify screen.
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Better Auth's phone-number plugin. Nothing AI runs until both are verified.
  phoneNumber: text("phone_number").unique(),
  phoneNumberVerified: boolean("phone_number_verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /*
    A closed account is locked out at once: every customer read
    (lib/customer-access.ts) refuses it, even for its own project. The row
    stays while it owns a project; removal on request is a later task.
  */
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => [
  // One account per email whatever its capitals (PR #25 review): Better Auth lowercases what it saves,
  // but any other path (a script, the customer app's own code) can't make "Ana@x.com" beside "ana@x.com".
  uniqueIndex("customer_email_lower_unique").on(sql`lower(${table.email})`),
]);
