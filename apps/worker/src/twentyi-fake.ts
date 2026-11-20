import { phpValueFor, sshKeyBody, stagingHostFor, TwentyiError, type CertificateFiles, type TwentyiApi, type TwentyiDatabase, type TwentyiPackage, type TwentyiPackageType } from "./twentyi";

/*
  An in-memory 20i reseller for tests (Build B on 20i, 5 October 2026): it
  makes packages, databases, SSH keys, domains and certificates (the shapes in 20i.apib, after twentyi.ts has read them), remembers
  each package's IP (and can be told to move one), and can be told to
  refuse any call. Nothing here reaches 20i.
*/

type Method = keyof TwentyiApi;

export interface FakePackage extends TwentyiPackage {
  enabled: boolean;
  /** The document root of each name (20i's documentRoots). */
  roots: Record<string, string>;
  databases: (TwentyiDatabase & { password: string })[];
  sshKeys: string[];
  php: string | null;
  certificates: { domain: string; certificate: string; caBundle: string; hasKey: boolean }[];
  /** How many times the whole cache was purged. */
  purged: number;
}

export class FakeTwentyi implements TwentyiApi {
  packages = new Map<string, FakePackage>();
  types: TwentyiPackageType[] = [{ id: "tawd-wp", label: "TAWD WordPress", platform: "linux" }];
  orders: { id: string; packageId: string; domain: string; periodMonths: number }[] = [];
  /** Every call, as "method arg", in order. */
  calls: string[] = [];
  /** Calls that fail, with 20i's message. */
  refuse: Partial<Record<Method, TwentyiError>> = {};
  /** Packages other than TAWD's on the account (they count towards the 50). */
  others = 0;
  /** Domains whose new package 20i is still setting up (setupComplete false until finishSetup). */
  slowSetup = new Set<string>();
  private next = 1001;
  private nextIp = 10;

  private hit(method: Method, detail = ""): void {
    this.calls.push(detail ? `${method} ${detail}` : method);
    const refusal = this.refuse[method];
    if (refusal) throw refusal;
  }

  private pkg(id: string): FakePackage {
    const p = this.packages.get(id);
    if (!p) throw new TwentyiError("20i doesn't know that.", "not_found", 404);
    return p;
  }

  /** 20i finishes setting a package up. */
  finishSetup(domain: string): void {
    for (const p of this.packages.values()) if (p.name === domain) p.setupComplete = true;
  }

  /** 20i moves a site to a new address (rare; the IP watch notices). */
  moveIp(packageId: string, ip: string): void {
    this.pkg(packageId).ipv4 = ip;
  }

  async listPackages() {
    this.hit("listPackages");
    const mine = [...this.packages.values()].map(({ id, name, names, typeRef, enabled }) => ({ id, name, names, typeRef, enabled }));
    const others = Array.from({ length: this.others }, (_, i) => ({ id: `other-${i}`, name: `other${i}.example.com`, names: [`other${i}.example.com`], typeRef: null, enabled: true }));
    return [...mine, ...others];
  }

  async getPackage(packageId: string) {
    this.hit("getPackage", packageId);
    const p = this.packages.get(packageId);
    if (!p) return null;
    const { id, name, names, typeRef, ipv4, ipv6, stagingHost, setupComplete } = p;
    return { id, name, names: [...names], typeRef, ipv4, ipv6, stagingHost, setupComplete };
  }

  async listPackageTypes() {
    this.hit("listPackageTypes");
    return this.types;
  }

  async createPackage(input: { typeId: string; domain: string; label: string }) {
    this.hit("createPackage", input.domain);
    // 20i (8 October 2026; confirmed 3 November): a subdomain can be a package's main name only once its parent domain's package is on the account.
    const parent = input.domain.split(".").slice(1).join(".");
    if (/\.(vmlpreview\.com|tawdpreviews\.com|preview\.velocitymedialab\.com)$/.test(input.domain) && ![...this.packages.values()].some((q) => q.name === parent || q.names.includes(parent)))
      throw new TwentyiError('20i said no (400): {"error":{"code":0,"message":"Subdomain not valid for request","data":null}}', "refused", 400);
    const id = String(this.next++);
    this.packages.set(id, {
      id,
      name: input.domain,
      names: [input.domain],
      typeRef: input.typeId,
      enabled: true,
      ipv4: `203.0.113.${this.nextIp++}`,
      ipv6: null,
      stagingHost: stagingHostFor(input.domain),
      setupComplete: !this.slowSetup.has(input.domain),
      roots: { [input.domain]: "public_html" },
      databases: [],
      sshKeys: [],
      php: null,
      certificates: [],
      purged: 0,
    });
    return id;
  }

  async deletePackage(packageId: string) {
    this.hit("deletePackage", packageId);
    this.pkg(packageId);
    this.packages.delete(packageId);
  }

  async setPackageEnabled(packageId: string, enabled: boolean) {
    this.hit("setPackageEnabled", `${packageId} ${enabled}`);
    this.pkg(packageId).enabled = enabled;
  }

  async addDomain(packageId: string, domain: string) {
    this.hit("addDomain", `${packageId} ${domain}`);
    const p = this.pkg(packageId);
    // 20i (8 October 2026): a subdomain needs its root domain's package on the account ("first add and finish setting up its root domain").
    const root = domain.split(".").slice(1).join(".");
    if (root.includes(".") && root !== p.name && ![...this.packages.values()].some((q) => q.name === root || q.names.includes(root)))
      throw new TwentyiError(`20i said no (403): Refused (platform policy): To add subdomain ${domain}, first add and finish setting up its root domain ${root} in this account`, "refused", 403);
    if (!p.names.includes(domain)) p.names.push(domain);
    p.roots[domain] = "public_html";
  }

  async documentRoots(packageId: string) {
    this.hit("documentRoots", packageId);
    return { ...this.pkg(packageId).roots };
  }

  async createDatabase(packageId: string, input: { name: string; password: string }) {
    this.hit("createDatabase", `${packageId} ${input.name}`);
    const p = this.pkg(packageId);
    // 20i may add a suffix to the names: the fake does, so TAWD must use what it answers.
    const name = `${input.name}_x1`;
    const db = { name, user: name, host: "mysql.stackcp.example", password: input.password };
    p.databases.push(db);
    return { name: db.name, user: db.user, host: db.host };
  }

  async listDatabases(packageId: string) {
    this.hit("listDatabases", packageId);
    return this.pkg(packageId).databases.map(({ name, user, host }) => ({ name, user, host }));
  }

  async addSshKey(packageId: string, publicKey: string) {
    this.hit("addSshKey", packageId);
    const p = this.pkg(packageId);
    if (p.sshKeys.some((k) => sshKeyBody(k) === sshKeyBody(publicKey))) return "present" as const;
    p.sshKeys.push(publicKey);
    return "added" as const;
  }

  async setPhpVersion(packageId: string, version: string) {
    this.hit("setPhpVersion", `${packageId} ${version}`);
    phpValueFor(version);
    this.pkg(packageId).php = version;
  }

  async purgeCache(packageId: string) {
    this.hit("purgeCache", packageId);
    this.pkg(packageId).purged += 1;
  }

  async installCertificate(packageId: string, files: CertificateFiles) {
    this.hit("installCertificate", `${packageId} ${files.names.join(" ")}`);
    const p = this.pkg(packageId);
    // One per name, as 20i's externalSSL; a new one replaces the old (TAWD removes older ones after installing).
    p.certificates = p.certificates.filter((c) => !files.names.includes(c.domain));
    for (const domain of files.names) p.certificates.push({ domain, certificate: files.certificate, caBundle: files.caBundle, hasKey: files.privateKey.includes("PRIVATE KEY") });
  }

  async orderCertificate(input: { packageId: string; domain: string; periodMonths: number }) {
    this.hit("orderCertificate", `${input.packageId} ${input.domain}`);
    this.pkg(input.packageId);
    const id = `tls-${this.orders.length + 1}`;
    this.orders.push({ id, packageId: input.packageId, domain: input.domain, periodMonths: input.periodMonths });
    // 20i's answer is only the id (no price, no renewal date).
    return { id, price: null, renewsAt: null };
  }
}
