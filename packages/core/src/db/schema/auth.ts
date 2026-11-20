import {
  bigint,
  boolean,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/*
  Tables owned by Better Auth.

  The property names on the left must stay camelCase: Better Auth's Drizzle
  adapter looks fields up by those names. The quoted strings are the real
  column names, which stay snake_case like the rest of the database.

  Do not add application concepts here. TAWD's own tables live in tawd.ts.
*/

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Better Auth's admin plugin.
  //
  // "role" here is NOT one of TAWD's five team roles. It is the plugin's own
  // admin switch, holding "admin" or "user". The team roles (Founder, PM,
  // Web Designer, SEO, Content) live in the user_role table in tawd.ts.
  role: text("role"),
  // The plugin calls this "banned". In TAWD's language a banned user is a
  // disabled user: blocked from signing in, history retained.
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),

  // TAWD's own addition. Admin-created accounts start with a temporary
  // password, so every new account must set a real one before going anywhere.
  mustChangePassword: boolean("must_change_password").notNull().default(true),

  // TAWD's own addition. Set when an admin deletes someone. The row stays,
  // because the append-only activity log points at it and cannot be
  // changed; everything that let the person sign in or act is removed, and
  // the name is kept so history reads "(deleted user) Sam Lee".
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  // The scrypt password hash for email-and-password accounts.
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Backs Better Auth's rate limiting. Stored in the database rather than in
// memory so the login throttle survives a redeploy.
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: bigint("count", { mode: "number" }).notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
