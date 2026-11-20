/*
  The trade playbooks' service families (Jason, 28 September 2026: the
  page plan's hub rule).

  Where a project has 3 or more services in one family, the page plan adds
  a hub page for the family: it targets the family's broad search term and
  links to each detailed page, which keeps its own page and keyword (group,
  don't merge). Only true duplicates, two services with the same search
  intent ("AC repair" and "Air conditioning repair"), become one page. Hubs
  count toward the tier's page limit and the PM can drop one.

  A family: its hub's name, the broad term the hub targets, the words that
  put a service in it (checked in order, first family wins), and synonyms
  that make two names the same intent. Trades with no families here get no
  hubs. Add a family by adding it here; the tests list what each matches.
*/

export interface ServiceFamily {
  /** The hub page's name, e.g. "Air conditioning". */
  hub: string;
  /** The broad search term the hub targets, before the area ("air conditioning"). */
  broad: string;
  /** A service belongs to the family when its name matches any of these... */
  match: RegExp[];
  /** ...and none of these ("water heater" is plumbing, not heating). */
  exclude?: RegExp[];
}

export interface TradePlaybook {
  families: ServiceFamily[];
  /** Words that mean the same thing in this trade, to find true duplicates. */
  synonyms: [RegExp, string][];
}

const GENERIC_SYNONYMS: [RegExp, string][] = [
  [/\bservices?\b/g, ""],
  [/\bcompany\b/g, ""],
  [/&|\band\b/g, " "],
  [/\binstallations?\b|\binstalls?\b/g, "install"],
  [/\breplacements?\b/g, "replace"],
  [/\brepairs?\b/g, "repair"],
];

export const TRADE_PLAYBOOKS: Partial<Record<string, TradePlaybook>> = {
  hvac: {
    families: [
      { hub: "Heating", broad: "heating", match: [/\bheat(ing|er)?\b/i, /\bfurnace/i, /\bboiler/i, /\bheat pump/i, /\bradiant/i], exclude: [/\bwater heat/i, /\bhot water/i] },
      { hub: "Air conditioning", broad: "air conditioning", match: [/\bac\b/i, /\ba\/c\b/i, /\bair condition/i, /\bcooling\b/i, /\bmini[- ]?split/i, /\bductless/i] },
      { hub: "Indoor air quality", broad: "indoor air quality", match: [/\bduct/i, /\bair quality/i, /\bair purif/i, /\b(de)?humidif/i, /\bair filter/i, /\bventilation/i] },
    ],
    synonyms: [
      [/\ba\/c\b|\bair condition(ing|er)s?\b/g, "ac"],
      [/\bhvac\b/g, ""],
    ],
  },
  plumbing: {
    families: [
      { hub: "Drains and sewers", broad: "drain and sewer services", match: [/\bdrain/i, /\bsewer/i, /\bclog/i, /\bhydro[- ]?jet/i, /\brooter/i, /\bseptic/i] },
      { hub: "Water heaters", broad: "water heater services", match: [/\bwater heater/i, /\btankless/i, /\bhot water/i] },
      { hub: "Leaks and pipes", broad: "leak repair and repiping", match: [/\bleak/i, /\brepip/i, /\bpipe/i, /\bslab/i, /\bwater line/i, /\bgas line/i] },
      { hub: "Fixtures", broad: "plumbing fixtures", match: [/\btoilet/i, /\bfaucet/i, /\bsink/i, /\bshower/i, /\bgarbage disposal/i, /\bbath(tub)?\b/i] },
    ],
    synonyms: [[/\bdrains?\b/g, "drain"], [/\bsewers?\b/g, "sewer"]],
  },
  pest_control: {
    families: [
      { hub: "Termites", broad: "termite control", match: [/\btermite/i, /\bwood[- ]destroying/i] },
      { hub: "Rodents and wildlife", broad: "rodent and wildlife control", match: [/\brodent/i, /\brats?\b/i, /\bmice\b|\bmouse\b/i, /\bwildlife/i, /\braccoon/i, /\bsquirrel/i, /\bbats?\b/i, /\bopossum/i] },
      { hub: "Stinging insects", broad: "stinging insect removal", match: [/\bwasp/i, /\bbees?\b/i, /\bhornet/i, /\byellow ?jacket/i] },
      { hub: "Insects", broad: "insect control", match: [/\bants?\b/i, /\broach/i, /\bspider/i, /\bbed ?bug/i, /\bflea/i, /\bticks?\b/i, /\bmosquito/i, /\bearwig/i, /\bsilverfish/i] },
    ],
    synonyms: [[/\bcockroach(es)?\b/g, "roach"], [/\bexterminat(ion|or|ing)\b/g, "control"], [/\bremoval\b/g, "control"]],
  },
  roofing: {
    families: [
      { hub: "Roof repair", broad: "roof repair", match: [/\brepair/i, /\bleak/i, /\bstorm/i, /\bhail/i, /\bemergency/i, /\btarp/i] },
      { hub: "Roof replacement", broad: "roof replacement", match: [/\breplace/i, /\bnew roof/i, /\breroof/i, /\binstall/i] },
      { hub: "Roofing materials", broad: "roofing materials", match: [/\bshingle/i, /\bmetal/i, /\btile\b/i, /\bflat\b/i, /\btpo\b/i, /\bslate/i, /\bcedar|shake/i] },
      { hub: "Gutters", broad: "gutter services", match: [/\bgutter/i, /\bdownspout/i] },
    ],
    synonyms: [[/\broofs?\b/g, "roof"], [/\broofing\b/g, "roof"]],
  },
  electrical: {
    families: [
      { hub: "Panels and wiring", broad: "electrical panels and wiring", match: [/\bpanel/i, /\bbreaker/i, /\brewir/i, /\bwiring\b/i, /\bservice upgrade/i, /\bsubpanel/i] },
      { hub: "Lighting", broad: "lighting installation", match: [/\blight/i, /\bfixture/i, /\bceiling fan/i] },
      { hub: "EV chargers and generators", broad: "EV chargers and generators", match: [/\bev\b/i, /\bcharger/i, /\bgenerator/i, /\bsolar/i, /\bbattery/i] },
      { hub: "Electrical safety", broad: "electrical safety", match: [/\binspection/i, /\bsurge/i, /\bgfci/i, /\bsmoke/i, /\bcode\b/i, /\boutlet/i] },
    ],
    synonyms: [[/\belectrical\b/g, ""], [/\belectrician\b/g, ""]],
  },
  legal: {
    families: [
      { hub: "Personal injury", broad: "personal injury lawyer", match: [/\binjur/i, /\baccident/i, /\bslip/i, /\bwrongful death/i, /\bmalpractice/i, /\bdog bite/i] },
      { hub: "Family law", broad: "family law attorney", match: [/\bdivorce/i, /\bcustody/i, /\bchild support/i, /\badoption/i, /\bprenup/i, /\balimony|spousal/i, /\bfamily/i] },
      { hub: "Criminal defense", broad: "criminal defense attorney", match: [/\bcriminal/i, /\bdui\b|\bdwi\b/i, /\bdrug/i, /\bassault/i, /\btheft/i, /\bexpung/i] },
      { hub: "Estate planning", broad: "estate planning attorney", match: [/\bestate/i, /\bwills?\b/i, /\btrusts?\b/i, /\bprobate/i, /\bpower of attorney/i, /\belder/i] },
      { hub: "Business law", broad: "business attorney", match: [/\bbusiness/i, /\bcontract/i, /\bllc\b/i, /\bcorporate/i, /\bemployment/i] },
      { hub: "Immigration", broad: "immigration lawyer", match: [/\bimmigra/i, /\bvisa/i, /\bgreen card/i, /\bcitizenship|naturali/i, /\bdeport/i] },
    ],
    synonyms: [[/\blawyers?\b|\battorneys?\b|\blaw\b/g, ""], [/\bdwi\b/g, "dui"]],
  },
  med_spa: {
    families: [
      { hub: "Injectables", broad: "injectables", match: [/\bbotox/i, /\bdysport/i, /\bxeomin/i, /\bfiller/i, /\blip/i, /\bkybella/i, /\binjectable/i, /\bneurotoxin/i] },
      { hub: "Skin treatments", broad: "skin treatments", match: [/\bfacial/i, /\bpeel/i, /\bmicroneedl/i, /\bhydrafacial/i, /\bresurfac/i, /\bskin\b/i, /\bacne/i] },
      { hub: "Laser and body", broad: "laser and body treatments", match: [/\blaser/i, /\bcoolsculpt|body contour/i, /\btattoo removal/i, /\bipl\b/i, /\bhair removal/i] },
      { hub: "Wellness", broad: "wellness treatments", match: [/\biv\b/i, /\bweight loss/i, /\bsemaglutide|tirzepatide/i, /\bhormone/i, /\bvitamin/i] },
    ],
    synonyms: [[/\btreatments?\b/g, ""]],
  },
};

/* A service name reduced to its search intent, for finding true duplicates. */
export function serviceIntent(name: string, trade: string): string {
  let s = ` ${name.toLowerCase()} `;
  for (const [pattern, to] of [...(TRADE_PLAYBOOKS[trade]?.synonyms ?? []), ...GENERIC_SYNONYMS]) s = s.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), ` ${to} `);
  return s
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

export interface GroupedServices {
  /** Families with 3 or more services: they get a hub. */
  hubs: { family: ServiceFamily; services: string[] }[];
  /** True duplicates: the service kept and the ones folded into it. */
  duplicates: { kept: string; folded: string[] }[];
  /** Every service kept, in the intake's order. */
  kept: string[];
}

/* The project's services by the trade's families: hubs for families of 3+, true duplicates folded. */
export function groupServices(services: string[], trade: string): GroupedServices {
  const kept: string[] = [];
  const duplicates: GroupedServices["duplicates"] = [];
  const byIntent = new Map<string, string>();
  for (const service of services) {
    const intent = serviceIntent(service, trade);
    const first = byIntent.get(intent);
    if (first && intent) {
      const entry = duplicates.find((d) => d.kept === first);
      if (entry) entry.folded.push(service);
      else duplicates.push({ kept: first, folded: [service] });
      continue;
    }
    byIntent.set(intent, service);
    kept.push(service);
  }
  const families = TRADE_PLAYBOOKS[trade]?.families ?? [];
  const members = new Map<ServiceFamily, string[]>();
  for (const service of kept) {
    const family = families.find((f) => f.match.some((m) => m.test(service)) && !(f.exclude ?? []).some((x) => x.test(service)));
    if (family) members.set(family, [...(members.get(family) ?? []), service]);
  }
  const hubs = families.filter((f) => (members.get(f)?.length ?? 0) >= 3).map((family) => ({ family, services: members.get(family)! }));
  return { hubs, duplicates, kept };
}
