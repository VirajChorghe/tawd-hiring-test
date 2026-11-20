/*
  Every environment variable TAWD reads, and which service reads it (Jason,
  27 September 2026, after DataForSEO failed with the login on the wrong
  service). The signed-in /api/health lists them with whether each service
  has it: the web app checks its own, the worker reports its own in its
  heartbeat. Only names and yes/no ever leave the container, never values.

  Keep this list up to date when a new variable is added, and name its
  services whenever asking for it to be set in Coolify.
*/

export type Service = "web" | "worker";

export interface EnvVar {
  name: string;
  services: Service[];
  /** "required": TAWD doesn't work without it; "optional": a feature waits for it; a group: at least one of the group. */
  need: "required" | "optional" | { oneOf: string };
  purpose: string;
}

export const ENV_VARS: EnvVar[] = [
  { name: "DATABASE_URL", services: ["web", "worker"], need: "required", purpose: "The database" },
  { name: "REDIS_URL", services: ["web", "worker"], need: "required", purpose: "The job queue" },
  { name: "BETTER_AUTH_SECRET", services: ["web"], need: "required", purpose: "Sign-in sessions" },
  { name: "BETTER_AUTH_URL", services: ["web"], need: "required", purpose: "The app's address, for sign-in and links" },
  { name: "TAWD_APP_URL", services: ["web", "worker"], need: "optional", purpose: "The app's address in Slack posts (BETTER_AUTH_URL is used when blank)" },
  { name: "TAWD_ENCRYPTION_KEY", services: ["web", "worker"], need: "required", purpose: "Encrypts Slack webhooks, client hosting logins, TAWD's SSH key and its Let's Encrypt account key" },
  { name: "R2_ACCOUNT_ID", services: ["web", "worker"], need: "required", purpose: "File storage (Cloudflare R2)" },
  { name: "R2_ACCESS_KEY_ID", services: ["web", "worker"], need: "required", purpose: "File storage (Cloudflare R2)" },
  { name: "R2_SECRET_ACCESS_KEY", services: ["web", "worker"], need: "required", purpose: "File storage (Cloudflare R2)" },
  { name: "R2_BUCKET", services: ["web", "worker"], need: "required", purpose: "File storage (Cloudflare R2)" },
  { name: "ANTHROPIC_API_KEY", services: ["worker"], need: "required", purpose: "Claude: every AI step runs on the worker" },
  { name: "ANTHROPIC_MODEL", services: ["web", "worker"], need: "optional", purpose: "The Claude model (a default is used when blank)" },
  { name: "ANTHROPIC_EFFORT", services: ["worker"], need: "optional", purpose: "How hard Claude thinks (a default is used when blank)" },
  { name: "ANTHROPIC_INPUT_PRICE_PER_MTOK", services: ["web", "worker"], need: "optional", purpose: "Claude's input price for estimates and Spend" },
  { name: "ANTHROPIC_OUTPUT_PRICE_PER_MTOK", services: ["web", "worker"], need: "optional", purpose: "Claude's output price for estimates and Spend" },
  { name: "FIGMA_ACCESS_TOKEN", services: ["web", "worker"], need: "optional", purpose: "Lane 2 Figma designs: the web app checks links, the worker imports" },
  { name: "SHUTTERSTOCK_CLIENT_ID", services: ["worker"], need: "optional", purpose: "Stock photo previews in mockups" },
  { name: "SHUTTERSTOCK_CLIENT_SECRET", services: ["worker"], need: "optional", purpose: "Stock photo previews in mockups" },
  { name: "DATAFORSEO_LOGIN", services: ["web"], need: "optional", purpose: "Keyword research, SEO audits and the TV market list" },
  { name: "DATAFORSEO_PASSWORD", services: ["web"], need: "optional", purpose: "Keyword research, SEO audits and the TV market list (the API password)" },
  { name: "DATAFORSEO_LIVE", services: ["web"], need: "optional", purpose: "\"on\" for paid live lookups; blank uses the free sandbox" },
  { name: "PAGESPEED_API_KEY", services: ["web", "worker"], need: "optional", purpose: "PageSpeed scores in SEO audits and the go-live SEO check" },
  { name: "ORIGINALITY_API_KEY", services: ["web"], need: "optional", purpose: "Originality checks of page drafts" },
  { name: "NETLIFY_AUTH_TOKEN", services: ["web"], need: "optional", purpose: "Publishing client sites to Netlify" },
  { name: "NETLIFY_FORM_COPY_EMAIL", services: ["web"], need: "optional", purpose: "VML's copy of every client form message" },
  { name: "NETLIFY_ACCOUNT_SLUG", services: ["web"], need: "optional", purpose: "The Netlify team, when the token has more than one" },
  { name: "CLOUDFLARE_API_TOKEN", services: ["web", "worker"], need: "optional", purpose: "Go-live: client zones on VML's Cloudflare account (Zone Edit and DNS Edit); the worker writes WordPress preview records and fixes a moved IP" },
  { name: "CLOUDFLARE_ACCOUNT_ID", services: ["web", "worker"], need: "optional", purpose: "Go-live: the VML Cloudflare account the client zones are made in (web and worker)" },
  { name: "POSTMARK_SERVER_TOKEN", services: ["web"], need: "optional", purpose: "Form messages through TAWD: the Postmark server's API token" },
  { name: "FORMS_FROM_EMAIL", services: ["web"], need: "optional", purpose: "Form messages: the address they come from (on a domain verified in Postmark)" },
  { name: "POSTMARK_WEBHOOK_SECRET", services: ["web"], need: "optional", purpose: "Form messages: the password in Postmark's delivery webhook (user tawd)" },
  { name: "GRAVITY_FORMS_LICENSE_KEY", services: ["worker"], need: "optional", purpose: "WordPress sites with Gravity Forms: VML's licence key, used to install it on each site" },
  { name: "VML_DNS_ACCESS_EMAIL", services: ["web"], need: "optional", purpose: "Connect the domain: the VML email clients give DNS access to (GoDaddy Delegate Access, Namecheap Share Access)" },
  { name: "RESEND_API_KEY", services: ["web"], need: { oneOf: "email" }, purpose: "Email (password resets): Resend, or SMTP below" },
  { name: "MAIL_FROM", services: ["web"], need: "optional", purpose: "The address TAWD's email comes from" },
  { name: "SMTP_HOST", services: ["web"], need: { oneOf: "email" }, purpose: "Email by SMTP, instead of Resend" },
  { name: "SMTP_PORT", services: ["web"], need: "optional", purpose: "Email by SMTP" },
  { name: "SMTP_USER", services: ["web"], need: "optional", purpose: "Email by SMTP" },
  { name: "SMTP_PASSWORD", services: ["web"], need: "optional", purpose: "Email by SMTP" },
  { name: "TWENTYI_API_KEY", services: ["worker"], need: "optional", purpose: "Build B: 20i's reseller API (the General API key); WordPress sites' hosting. Worker only: the web app queues jobs" },
  { name: "WP_PREVIEW_DOMAIN", services: ["web", "worker"], need: "optional", purpose: "Build B: the VML domain WordPress previews live under (decision D1); blank uses 20i's staging address" },
  { name: "TWENTYI_ACME_STAGING", services: ["worker"], need: "optional", purpose: "Build B: \"on\" to use Let's Encrypt's staging directory (first trials only)" },
  { name: "JINA_API_KEY", services: ["worker"], need: "optional", purpose: "Blocked sites: Jina Reader, the first paid route for a current site that blocks TAWD's server" },
  { name: "ZYTE_API_KEY", services: ["worker"], need: "optional", purpose: "Blocked sites: Zyte, the second paid route (after Jina Reader)" },
  { name: "SKILLS_DIR", services: ["worker"], need: "optional", purpose: "Where the design skills are (the image's own folder when blank)" },
];

/* Which of this service's variables are set: names and yes/no only, never a value. */
export function envPresence(service: Service, env: Record<string, string | undefined> = process.env): Record<string, boolean> {
  return Object.fromEntries(ENV_VARS.filter((v) => v.services.includes(service)).map((v) => [v.name, Boolean(env[v.name]?.trim())]));
}

export interface SettingRow {
  name: string;
  purpose: string;
  need: "required" | "optional" | "one of a group";
  /** true or false where the service reads it; "not used" where it doesn't; "unknown" when the worker hasn't reported. */
  web: boolean | "not used";
  worker: boolean | "not used" | "unknown";
  /** Required (or the last of its group) and missing on a service that reads it. */
  missing: boolean;
}

/* The settings table for the health page, from the web app's own presence and the worker's report. */
export function settingsCheck(web: Record<string, boolean>, worker: Record<string, boolean> | null): { rows: SettingRow[]; missing: string[] } {
  const groupOk = (group: string, service: Service) =>
    ENV_VARS.some((v) => typeof v.need === "object" && v.need.oneOf === group && v.services.includes(service) && (service === "web" ? web[v.name] : worker?.[v.name]));
  const rows = ENV_VARS.map((v): SettingRow => {
    const onWeb = v.services.includes("web") ? Boolean(web[v.name]) : ("not used" as const);
    const onWorker = v.services.includes("worker") ? (worker ? Boolean(worker[v.name]) : ("unknown" as const)) : ("not used" as const);
    const lacking = (service: Service, present: boolean | string) =>
      present === false && (v.need === "required" || (typeof v.need === "object" && !groupOk(v.need.oneOf, service)));
    return {
      name: v.name,
      purpose: v.purpose,
      need: typeof v.need === "object" ? "one of a group" : v.need,
      web: onWeb,
      worker: onWorker,
      missing: lacking("web", onWeb) || lacking("worker", onWorker),
    };
  });
  const missing = rows.flatMap((r) => {
    const where = [r.web === false && r.missing ? "web app" : null, r.worker === false && r.missing ? "worker" : null].filter(Boolean);
    return r.missing ? [`${r.name} on the ${where.join(" and ")}`] : [];
  });
  return { rows, missing };
}
