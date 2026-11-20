/*
  VML's privacy and cookie policy templates and the state rules (28 September
  2026), exactly as in docs/policies, which is the source: after changing
  anything there, regenerate this file with
  `node packages/core/scripts/policy-templates.mjs` (a test checks they match).
*/

export const PRIVACY_TEMPLATE = "# Privacy Policy\n\n**Effective date:** {{policy.effective_date}}\n\nThis privacy policy explains how {{business.legal_name}} (\"we\", \"us\") collects, uses and protects information when you use {{site.url}} (the \"site\"). It applies only to information collected through this site.\n\n## Information we collect\n\n[[IF site.business]]\n**Information you give us.** When you call us, email us, or send a form on this site, we collect what you choose to provide, such as your name, phone number, email address, service address or ZIP code, and details about the service you need.\n[[END]]\n[[IF site.personal]]\n**Information you give us.** When you email us or send a message through this site, we collect what you choose to provide, such as your name, email address and your message.\n[[END]]\n\n**Information collected automatically.** Like most websites, our hosting provider automatically records basic technical information, such as your IP address, browser type and the pages you visit, to keep the site secure and working.\n[[IF tracking.any]]\nWith your consent (or unless you opt out, where the law allows), we also use analytics and advertising tools that use cookies. See our [Cookie Policy]({{site.cookie_policy_url}}) for details.\n[[END]]\n[[IF tracking.call_rail]]\n**Calls to our tracking numbers.** With your consent (or unless you opt out, where the law allows), this site shows a call tracking phone number. When you call it, our call tracking provider records details of the call, such as your phone number, the time and length of the call, and which page or ad led to it, so we can tell which parts of our marketing work.\n[[END]]\n\n## How we use your information\n\nWe use your information to:\n\n[[IF site.business]]\n- respond to your request and provide the services you ask for;\n- schedule appointments and follow up about your service;\n[[END]]\n[[IF site.personal]]\n- read and reply to your messages;\n[[END]]\n- keep the site secure and working properly;\n[[IF tracking.any]]\n- understand how visitors use the site and measure our advertising;\n[[END]]\n- meet our legal obligations.\n\n[[IF site.business]]\nUnless you ask us not to, we may contact you about your service or related offers. You can opt out at any time (see \"Your choices and rights\" below).\n[[END]]\n[[IF site.personal]]\nWe use your contact details only to reply to you. We do not send marketing messages.\n[[END]]\n\n## How we share your information\n\nWe do not sell your personal information for money. We share it only:\n\n- with service providers who help us run our business and this site, such as our website host and form service ({{site.hosting_provider}}), [[IF tracking.ga4]]Google Analytics, [[END]][[IF tracking.gtm]]Google Tag Manager, [[END]][[IF tracking.meta_pixel]]Meta (Facebook), [[END]][[IF tracking.google_ads]]Google Ads, [[END]][[IF tracking.call_rail]]CallRail (call tracking), [[END]][[IF site.business]]and our scheduling or customer management tools, [[END]]who may use it only to provide their services to us;\n- when required by law, or to protect our rights or the safety of others;\n[[IF site.business]]\n- with a buyer or successor if our business is sold or merged.\n[[END]]\n\n[[IF tracking.advertising]]\nSome advertising cookies on this site may count as \"sharing\" of personal information for cross-context behavioral advertising under California law. You can opt out using the **\"Do Not Sell or Share My Personal Information\"** link at the bottom of every page.\n[[END]]\n\n## Your choices and rights\n\nYou can contact us at any time to:\n\n- ask what personal information we have about you;\n- ask us to correct or delete it;\n- opt out of marketing messages;\n[[IF tracking.advertising]]\n- opt out of the sale or sharing of your personal information, using the **\"Do Not Sell or Share My Personal Information\"** link or by contacting us;\n[[END]]\n- raise a concern about how we use your information.\n\n**California residents** have these rights under the California Consumer Privacy Act (CCPA), as amended by the CPRA, including the right to know, delete, correct, and opt out of the sale or sharing of personal information, and the right not to be treated differently for using these rights. We will verify your request before acting on it.\n\n**Global Privacy Control:** this site honors the Global Privacy Control (GPC) browser signal as a request to opt out of the sale or sharing of personal information.\n\n**Do Not Track:** our site does not respond to other \"Do Not Track\" browser signals, because there is no common standard for them. We honor Global Privacy Control as described above.\n\n## How long we keep information\n\n[[IF site.business]]\nWe keep personal information only as long as needed to provide our services, keep business records, and meet legal obligations, then delete or anonymize it.\n[[END]]\n[[IF site.personal]]\nWe keep personal information only as long as needed to reply to you and meet legal obligations, then delete it.\n[[END]]\n\n## Security\n\nWe use reasonable administrative, technical and physical safeguards to protect your information, suited to [[IF site.business]]the size of our business[[END]][[IF site.personal]]a small personal website[[END]] and the sensitivity of the information. This site uses HTTPS encryption, only people and service providers who need your information to do their jobs can access it, and we delete it once we no longer need it. No website or transmission is completely secure, so we cannot guarantee absolute security; please do not send payment card numbers, Social Security numbers or medical details through our forms. If a security breach affects your personal information, we will notify you and the authorities as the law requires.\n\n## Children's privacy\n\nThis site is not directed to children under 13, and we do not knowingly collect personal information from them. If you believe a child has sent us information, contact us and we will delete it.\n\n## Links to other sites\n\nThis site may link to other websites. We are not responsible for their content or privacy practices, so please review their privacy policies.\n\n## Changes to this policy\n\nWe may update this policy from time to time. We will post the updated version on this page with a new effective date.\n\n## Contact us\n\n{{business.legal_name}}\n[[IF site.business]]\n{{business.address}}\nPhone: {{business.phone}}\n[[END]]\nEmail: {{business.privacy_email}}\n";

export const COOKIE_TEMPLATE = "# Cookie Policy\n\n**Effective date:** {{policy.effective_date}}\n\nThis cookie policy explains how {{business.legal_name}} uses cookies and similar technologies on {{site.url}}. For how we handle personal information, see our [Privacy Policy]({{site.privacy_policy_url}}).\n\n## What cookies are\n\nCookies are small text files that a website stores on your device. They help the site work, remember your choices, and, with your permission, help us understand how visitors use the site.\n\n## Cookies we use\n\n**Strictly necessary.** These keep the site working and secure, and remember your cookie choices. They are always on.\n[[IF tracking.analytics]]\n\n**Analytics.** These help us understand how visitors find and use the site, such as which pages are visited and for how long, so we can improve it.\n[[IF tracking.ga4]]\n- Google Analytics (Google). Learn more: https://policies.google.com/technologies/cookies\n[[END]]\n[[IF tracking.gtm]]\n- Google Tag Manager (Google), which loads the tools listed here.\n[[END]]\n[[IF tracking.call_rail]]\n- CallRail call tracking (CallRail), which shows a tracking phone number so we can tell which page or ad led to a call. Learn more: https://www.callrail.com/privacy\n[[END]]\n[[END]]\n[[IF tracking.advertising]]\n\n**Advertising.** These measure how our ads perform and may be used to show you relevant ads on other sites.\n[[IF tracking.google_ads]]\n- Google Ads conversion tracking (Google). Learn more: https://policies.google.com/technologies/ads\n[[END]]\n[[IF tracking.meta_pixel]]\n- Meta Pixel (Meta Platforms). Learn more: https://www.facebook.com/privacy/policies/cookies/\n[[END]]\n[[END]]\n\n## Your choices\n\n[[IF tracking.consent_mode == \"ask_first\"]]\nAnalytics and advertising cookies are only set after you accept them in the cookie banner. You can change your choice at any time using the **Cookie settings** link at the bottom of every page.\n[[END]]\n[[IF tracking.consent_mode == \"opt_out\"]]\nYou can turn off analytics and advertising cookies at any time using the **Cookie settings** or **\"Do Not Sell or Share My Personal Information\"** link at the bottom of every page. This site also honors the Global Privacy Control (GPC) browser signal.\n[[END]]\n\nYou can also block or delete cookies in your browser settings. Blocking strictly necessary cookies may stop parts of the site from working.\n\n## Changes to this policy\n\nWe may update this policy when the tools we use change. The updated version will be posted here with a new effective date.\n\n## Contact us\n\n{{business.legal_name}}\nPhone: {{business.phone}}\nEmail: {{business.privacy_email}}\n";

export const STATE_LAW_RULES = [
  {
    "key": "CA-caloppa",
    "state": "CA",
    "stateName": "California",
    "lawName": "California Online Privacy Protection Act (CalOPPA)",
    "citation": "Cal. Bus. & Prof. Code §§ 22575-22579",
    "appliesTo": "Any operator of a commercial website that collects personally identifiable information (name, email, phone, address) from California residents. No size threshold.",
    "coverage": "yes",
    "sourceUrls": [
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=22575"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked § 22575 on the official site; §§ 22576-22579 not opened. The baseline already covers the categories collected, sharing, review and correction, changes and the effective date.",
    "addOn": "## California residents\n\n[[IF tracking.any]]\n**Tracking across websites.** Only with your consent (or unless you opt out, where the law allows), this site uses tools from Google and Meta that may collect information about your activity on this site, and over time across other websites, for analytics and advertising. You can change your choice at any time using **Cookie settings**.\n[[END]]\n\n**Do Not Track and Global Privacy Control.** We treat a Global Privacy Control (GPC) signal from your browser as a request to opt out, and we don't load analytics or advertising tools when we detect it. Browsers' older \"Do Not Track\" setting has no agreed standard, so we honor GPC instead.\n\n**Reviewing or correcting your information.** To see, correct or delete information you sent us, email {{business.privacy_email}} or call {{business.phone}}.\n"
  },
  {
    "key": "CA-ccpa",
    "state": "CA",
    "stateName": "California",
    "lawName": "California Consumer Privacy Act, as amended by the CPRA (CCPA)",
    "citation": "Cal. Civ. Code § 1798.100 et seq.; Cal. Code Regs. tit. 11, § 7000 et seq.",
    "appliesTo": "For-profit businesses doing business in California with over $26,625,000 annual revenue (CPI-adjusted from 2025), or that buy, sell or share personal information of 100,000+ California consumers or households a year, or earn 50%+ of revenue from selling or sharing it. Ad pixels count as sharing.",
    "coverage": "no",
    "sourceUrls": [
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.130",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.135",
      "https://cppa.ca.gov/regulations/cpi_adjustment.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Rarely covers a local service business; offered to Californians anyway. A covered business needs a toll-free number unless online-only, and must update the policy every 12 months.",
    "addOn": "### Your California privacy rights\n\nIf you live in California, you can ask {{business.legal_name}} to:\n\n- tell you what personal information we collected about you, where it came from, why we collected it and who we disclosed it to;\n- delete or correct it;\n- stop selling or sharing it for cross-context behavioral advertising (we also honor Global Privacy Control).\n\nWe do not sell personal information for money. The personal information we collect is your contact details and your message (from you), and device and browsing information (from the site[[IF tracking.any]] and, only with your consent, from cookies and tags[[END]])[[IF tracking.call_rail]], and the details of calls to our call tracking numbers (from our call tracking provider)[[END]]. We use it to answer you and provide our services[[IF tracking.any]], and with your consent to measure visits and our advertising[[END]]. We will not treat you differently for using these rights.\n\nTo make a request, email {{business.privacy_email}} or call {{business.phone}}. We may need to verify your identity. An authorized agent may make a request for you.\n"
  },
  {
    "key": "NV-603a",
    "state": "NV",
    "stateName": "Nevada",
    "lawName": "Nevada privacy of information collected on the Internet (operator notice and sale opt-out)",
    "citation": "NRS 603A.300-603A.360 (603A.340 notice, 603A.345 opt-out)",
    "appliesTo": "Operators of commercial websites that collect name, address, email, phone or other identifiers from Nevada consumers and do business in or target Nevada. The notice duty doesn't apply to a Nevada-based operator whose revenue is mainly not from the internet and whose site has under 20,000 unique visitors a year.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://www.leg.state.nv.us/NRS/NRS-603A.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED on the official site: leg.state.nv.us blocks automated reading; the law was read from a mirror (nevada.public.law). Wording: Jason's section (28 September 2026), the tracking sentence only when tracking is on. An admin should open the official NRS 603A page and tick it.",
    "addOn": "## Nevada residents\n\nNevada law lets Nevada residents ask that we not sell certain personal information. We do not sell personal information, but you can still send an opt-out request to {{business.privacy_email}}, and we will record it. This policy describes the information we collect, who we share it with, how you can review and request changes to it, and how we tell you about changes to this policy, as Nevada law requires.[[IF tracking.any]] Third parties, such as the analytics and advertising tools described in our [Cookie Policy]({{site.cookie_policy_url}}), may collect information about your online activity over time and across websites when you use this site.[[END]]\n"
  },
  {
    "key": "NV-health",
    "state": "NV",
    "stateName": "Nevada",
    "lawName": "Nevada consumer health data privacy law (SB 370, 2023)",
    "citation": "SB 370 (2023), reported codified at NRS 603A.400-603A.550",
    "appliesTo": "Anyone doing business in Nevada or targeting Nevada consumers who collects consumer health data (for example a med spa's treatments or conditions). No size threshold reported; HIPAA-covered data exempt.",
    "coverage": "maybe",
    "sourceUrls": [],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: no official source could be opened; written from the law as reported (the founders chose no counsel step). Only for health and beauty projects in Nevada. The law also requires consent before collecting health data beyond what's needed for the service asked for, separate consent before sharing it, and a signed authorization before any sale; TAWD sites do none of those. An admin should check the official NRS 603A pages and tick it.",
    "healthOnly": true,
    "addOn": "### Nevada residents: consumer health data\n\nThis part is our consumer health data privacy policy under Nevada law.\n\n- **What we collect and why.** If you tell us about your health through our forms, by email or by phone (for example a treatment you're interested in, a condition or a medication), we collect it only to answer you and provide the services you ask for.\n- **Where it comes from.** From you.\n- **Who we share it with.** Only the service providers that run this site and our messages, such as {{site.hosting_provider}}, to do that work for us. We do not sell consumer health data, and we do not share it for any other purpose without your consent.\n- **Your rights.** You can ask us to confirm whether we collect, share or sell your consumer health data; to give you a list of every third party we have shared it with, and how to contact them; to stop collecting, sharing or selling it; and to delete it.\n- **How to ask.** Email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject.\n- **No geofencing.** We do not use a virtual boundary around any health care facility to track or message you.\n"
  },
  {
    "key": "DE-doppa",
    "state": "DE",
    "stateName": "Delaware",
    "lawName": "Delaware Online Privacy and Protection Act (DOPPA)",
    "citation": "6 Del. C. §§ 1201C-1206C (policy: § 1205C)",
    "appliesTo": "Any operator of a commercial website that collects personally identifiable information from Delaware users. No size threshold.",
    "coverage": "yes",
    "sourceUrls": [
      "https://delcode.delaware.gov/title6/c012c/index.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on delcode.delaware.gov. The baseline covers the required contents and it's linked from every page with a link containing \"Privacy\". The rights and appeal below follow the DPDPA (next row), offered to every Delaware resident.",
    "addOn": "## Delaware residents\n\nThis policy is linked from every page of {{site.url}} as \"Privacy Policy\". It describes the personal information we collect, who we may share it with, how to review or correct it, how we announce changes, its effective date, how we respond to Global Privacy Control[[IF tracking.any]], and that Google and Meta may collect information about your activity across websites only with your consent[[END]].\n\nIf you live in Delaware, you can ask {{business.legal_name}} to confirm whether we process your personal data, give you a copy, or correct or delete it, and you can opt out of targeted advertising and the sale of personal data. Email {{business.privacy_email}} or call {{business.phone}}. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing and explain our decision.\n"
  },
  {
    "key": "DE-dpdpa",
    "state": "DE",
    "stateName": "Delaware",
    "lawName": "Delaware Personal Data Privacy Act (DPDPA)",
    "citation": "6 Del. C. ch. 12D (thresholds § 12D-103, notice § 12D-106)",
    "appliesTo": "Businesses doing business in or targeting Delaware that controlled or processed personal data of 35,000+ Delaware consumers in the prior year, or 10,000+ with over 20% of revenue from selling personal data. From 2027-01-01: 10,000, or 5,000 plus 20% from sales.",
    "coverage": "no",
    "sourceUrls": [
      "https://delcode.delaware.gov/title6/c012d/index.html",
      "https://attorneygeneral.delaware.gov/fraud/personal-data-privacy-portal/"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Covered by the Delaware section above (rights and appeal); the thresholds drop in 2027.",
    "addOn": ""
  },
  {
    "key": "NY-none",
    "state": "NY",
    "stateName": "New York",
    "lawName": "No comprehensive consumer privacy law (New York Privacy Act not enacted)",
    "citation": "S3044 (2025-2026 session) and companions; not law",
    "appliesTo": "Nothing yet. As of 2026-09-28 the New York Privacy Act hasn't passed either house. The SHIELD Act (Gen. Bus. Law §§ 899-aa, 899-bb: reasonable data security and breach notice, any size of business) is covered in the baseline's Security section.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.nysenate.gov/legislation/bills/2025/S3044",
      "https://www.nysenate.gov/legislation/laws/GBS/899-BB",
      "https://www.nysenate.gov/legislation/laws/GBS/899-AA"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Check again before the 2027 session. A revised NY Health Information Privacy Act was reintroduced in 2026 and could matter for med spas if enacted.",
    "addOn": ""
  },
  {
    "key": "VA-vcdpa",
    "state": "VA",
    "stateName": "Virginia",
    "lawName": "Virginia Consumer Data Protection Act (VCDPA)",
    "citation": "Va. Code §§ 59.1-575 to 59.1-585",
    "appliesTo": "Businesses doing business in or targeting Virginia that process personal data of 100,000+ Virginia consumers a year, or 25,000+ with over 50% of revenue from selling personal data.",
    "coverage": "no",
    "sourceUrls": [
      "https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-576/",
      "https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-577/",
      "https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-578/"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "2026 c. 820 (from July 1, 2026) bans selling precise geolocation data; TAWD sites don't collect it.",
    "addOn": "## Virginia residents\n\nIf you live in Virginia, the Virginia Consumer Data Protection Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy of data you gave us; and to opt out of targeted advertising, the sale of personal data, and profiling used for decisions with legal or similarly significant effects. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal we will tell you how to contact the Virginia Attorney General.\n"
  },
  {
    "key": "CO-cpa",
    "state": "CO",
    "stateName": "Colorado",
    "lawName": "Colorado Privacy Act (CPA)",
    "citation": "C.R.S. §§ 6-1-1301 to 6-1-1313; rules 4 CCR 904-3",
    "appliesTo": "Businesses doing business in or targeting Colorado that process personal data of 100,000+ Colorado consumers a year, or earn revenue from selling personal data and process data of 25,000+. The 2025 biometric rules apply to any business that collects biometric identifiers.",
    "coverage": "no",
    "sourceUrls": [
      "https://coag.gov/resources/colorado-privacy-act/",
      "https://leg.colorado.gov/bills/sb21-190",
      "https://leg.colorado.gov/bills/hb24-1130"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Colorado AG's page; the statute text itself couldn't be opened, so no appeal deadline is stated. Honor GPC (the one recognized universal opt-out) — TAWD's sites do.",
    "addOn": "## Colorado residents\n\nIf you live in Colorado, the Colorado Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend by 45 more days if we tell you why. If your browser sends a Global Privacy Control signal, we treat it as your request to opt out of targeted advertising and sale on that browser. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing, and if we deny your appeal we will tell you how to contact the Colorado Attorney General.\n"
  },
  {
    "key": "CT-ctdpa",
    "state": "CT",
    "stateName": "Connecticut",
    "lawName": "Connecticut Data Privacy Act (CTDPA), as amended by Public Act 25-113",
    "citation": "Conn. Gen. Stat. § 42-515 et seq.",
    "appliesTo": "From July 1, 2026: businesses doing business in or targeting Connecticut that processed personal data of 35,000+ consumers in the prior year, OR processed any consumer's sensitive data (for example health information from a med spa), OR offered personal data for sale. Consumer health data rules apply whatever the size.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://portal.ct.gov/ag/sections/privacy/the-connecticut-data-privacy-act"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Connecticut AG's page; the statute and PA 25-113 text couldn't be opened. Med spas are likely covered. The large-language-model sentence must be true for each client.",
    "addOn": "## Connecticut residents\n\nIf you live in Connecticut, the Connecticut Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. We do not collect, use or sell personal data to train large language models. We treat a Global Privacy Control signal as a request to opt out of targeted advertising and sale. To make a request, email {{business.privacy_email}} or call {{business.phone}}. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal we will tell you how to contact the Connecticut Attorney General.\n"
  },
  {
    "key": "UT-ucpa",
    "state": "UT",
    "stateName": "Utah",
    "lawName": "Utah Consumer Privacy Act (UCPA)",
    "citation": "Utah Code Title 13, Chapter 61",
    "appliesTo": "Businesses with $25 million+ annual revenue doing business in or targeting Utah that process personal data of 100,000+ Utah consumers a year, or 25,000+ with over 50% of revenue from selling personal data.",
    "coverage": "no",
    "sourceUrls": [
      "https://attorneygeneral.utah.gov/data-privacy-2/"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Utah AG's page; le.utah.gov couldn't be opened. The UCPA has no appeal duty. HB 418 (2025) adds a right to correct, reported from July 1, 2026.",
    "addOn": "## Utah residents\n\nIf you live in Utah, the Utah Consumer Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct inaccuracies; to delete personal data you gave us; to get a portable copy of data you gave us; and to opt out of targeted advertising and the sale of personal data. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days.\n"
  },
  {
    "key": "IA-icdpa",
    "state": "IA",
    "stateName": "Iowa",
    "lawName": "Iowa Consumer Data Protection Act (ICDPA)",
    "citation": "Iowa Code ch. 715D",
    "appliesTo": "Businesses doing business in or targeting Iowa that process personal data of 100,000+ Iowa consumers a year, or 25,000+ with over 50% of revenue from selling personal data.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.legis.iowa.gov/docs/code/715D.pdf"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Iowa Legislature's code. Iowa grants no right to correct and no targeted-advertising opt-out by law; the baseline offers both anyway.",
    "addOn": "## Iowa residents\n\nIf you live in Iowa, the Iowa Consumer Data Protection Act gives you the right to confirm whether we process your personal data and to access it; to delete personal data you gave us; to get a portable copy of data you gave us; and to opt out of the sale of personal data. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 90 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal we will give you a way to contact the Iowa Attorney General.\n"
  },
  {
    "key": "IN-icdpa",
    "state": "IN",
    "stateName": "Indiana",
    "lawName": "Indiana Consumer Data Protection Act",
    "citation": "Ind. Code art. 24-15",
    "appliesTo": "Businesses doing business in or targeting Indiana that process personal data of 100,000+ Indiana consumers a year, or 25,000+ with over 50% of revenue from selling personal data. In force January 1, 2026.",
    "coverage": "no",
    "sourceUrls": [
      "https://iga.in.gov/laws/2025/ic/titles/24#24-15"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: no official page could be read (iga.in.gov needs JavaScript; in.gov refused). The wording follows the Virginia model Indiana is based on; an admin should check IC 24-15 and tick it.",
    "addOn": "## Indiana residents\n\nIf you live in Indiana, the Indiana Consumer Data Protection Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a copy of data you gave us; and to opt out of targeted advertising, the sale of personal data, and profiling used for decisions with legal or similarly significant effects. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing, and if we deny your appeal we will tell you how to contact the Indiana Attorney General.\n"
  },
  {
    "key": "TN-tipa",
    "state": "TN",
    "stateName": "Tennessee",
    "lawName": "Tennessee Information Protection Act (TIPA)",
    "citation": "Tenn. Code Ann. § 47-18-3201 et seq.",
    "appliesTo": "Businesses with over $25 million annual revenue doing business in or targeting Tennessee that process personal information of 175,000+ Tennessee consumers a year, or 25,000+ with over 50% of revenue from selling it. In force July 1, 2025.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.tn.gov/attorneygeneral/news/2025/4/30/pr25-25.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED beyond an AG press release: the bill and statute text couldn't be opened, so no appeal deadline is stated. An admin should check the statute and tick it.",
    "addOn": "## Tennessee residents\n\nIf you live in Tennessee, the Tennessee Information Protection Act gives you the right to confirm whether we process your personal information and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, profiling, and the sale of personal information. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days. If we deny your request we will explain why, and you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply to your appeal in writing.\n"
  },
  {
    "key": "MT-mcdpa",
    "state": "MT",
    "stateName": "Montana",
    "lawName": "Montana Consumer Data Privacy Act (MCDPA), as amended by SB 297 (2025)",
    "citation": "Mont. Code Ann. § 30-14-2801 et seq.",
    "appliesTo": "Businesses doing business in or targeting Montana that process personal data of 25,000+ Montana consumers, or 15,000+ with over 25% of revenue from selling personal data.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://mca.legmt.gov/bills/mca/title_0300/chapter_0140/part_0280/section_0030/0300-0140-0280-0030.html",
      "https://mca.legmt.gov/bills/mca/title_0300/chapter_0140/part_0280/section_0080/0300-0140-0280-0080.html",
      "https://mca.legmt.gov/bills/mca/title_0300/chapter_0140/part_0280/section_0120/0300-0140-0280-0120.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Low threshold: a busy Montana site with analytics could reach it. The notice must show when it was last updated (the effective date at the top does).",
    "addOn": "## Montana residents\n\nIf you live in Montana, the Montana Consumer Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal we will give you a way to contact the Montana Attorney General.\n"
  },
  {
    "key": "TX-tdpsa",
    "state": "TX",
    "stateName": "Texas",
    "lawName": "Texas Data Privacy and Security Act (TDPSA)",
    "citation": "Tex. Bus. & Com. Code ch. 541",
    "appliesTo": "Anyone doing business in Texas or whose products or services Texans use, with no consumer-count or revenue threshold; businesses that are small by U.S. SBA standards are exempt, except they must get consent before selling sensitive data.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Texas AG's page; the statute site needs JavaScript. TAWD sites don't sell sensitive or biometric data, so the required \"NOTICE: We may sell...\" statements are left out; add them only for a client that does.",
    "addOn": "## Texas residents\n\nIf you live in Texas, the Texas Data Privacy and Security Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; and to opt out of targeted advertising, the sale of personal data, and profiling used for significant decisions. We will not discriminate against you for using these rights. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend by 45 more days if we tell you why. If we decline your request we will explain why, and you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. If we deny your appeal, we will tell you how to submit a complaint to the Texas Attorney General.\n"
  },
  {
    "key": "OR-ocpa",
    "state": "OR",
    "stateName": "Oregon",
    "lawName": "Oregon Consumer Privacy Act (OCPA)",
    "citation": "ORS 646A.570 to 646A.589",
    "appliesTo": "Businesses and nonprofits doing business in Oregon that process personal data of 100,000+ Oregon consumers a year, or 25,000+ with over 25% of revenue from selling personal data. Must honor GPC from January 1, 2026.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/",
      "https://www.doj.state.or.us/consumer-protection/for-businesses/privacy-law-faqs-for-businesses/"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Oregon DOJ's pages; the statute site couldn't be opened, so the appeal wording follows the DOJ FAQ.",
    "addOn": "## Oregon residents\n\nIf you live in Oregon, the Oregon Consumer Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; to opt out of targeted advertising, the sale of personal data, and certain profiling; and to ask for a list of the specific third parties (other than individuals) we have disclosed your personal data to. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. If we deny your appeal, you can contact the Oregon Department of Justice.\n"
  },
  {
    "key": "FL-fdbr",
    "state": "FL",
    "stateName": "Florida",
    "lawName": "Florida Digital Bill of Rights",
    "citation": "Fla. Stat. §§ 501.701 to 501.722 (sensitive data sale: § 501.715)",
    "appliesTo": "Mainly companies with over $1 billion revenue that also sell online ads, run a smart speaker or an app store. § 501.715 (consent and a notice before selling sensitive data) applies to any for-profit business.",
    "coverage": "no",
    "sourceUrls": [
      "http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/0501PARTVContentsIndex.html",
      "http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.715.html"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Florida Legislature's statutes. TAWD sites never sell sensitive data, so the required \"NOTICE: This website may sell your sensitive personal data\" line is left out.",
    "addOn": "## Florida residents\n\nFlorida's Digital Bill of Rights applies mainly to very large companies. If you live in Florida, you can still use the access, correction, deletion and opt-out choices in this policy: email {{business.privacy_email}} or call {{business.phone}}. {{business.legal_name}} does not sell sensitive personal data.\n"
  },
  {
    "key": "NH-nhdpa",
    "state": "NH",
    "stateName": "New Hampshire",
    "lawName": "New Hampshire Data Privacy Act (NHDPA)",
    "citation": "RSA 507-H",
    "appliesTo": "Businesses doing business in or targeting New Hampshire that process personal data of 35,000+ NH consumers a year, or 10,000+ with over 25% of revenue from selling personal data.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://gc.nh.gov/rsa/html/NHTOC/NHTOC-LII-507-H.htm"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: every official NH page (the RSA and the AG's FAQ) refused automated reading; the thresholds and deadlines come from search snippets and prior knowledge. A busy local site could reach 35,000.",
    "addOn": "## New Hampshire residents\n\nIf you live in New Hampshire, the New Hampshire Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal you can complain to the New Hampshire Attorney General's Consumer Protection and Antitrust Bureau.\n"
  },
  {
    "key": "NJ-njdpa",
    "state": "NJ",
    "stateName": "New Jersey",
    "lawName": "New Jersey Data Privacy Act (NJDPA)",
    "citation": "N.J.S.A. 56:8-166.4 et seq.; proposed rules N.J.A.C. 13:45L",
    "appliesTo": "Businesses doing business in or targeting New Jersey that process personal data of 100,000+ NJ consumers a year, or 25,000+ and earn any revenue or discount from selling personal data.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.njoag.gov/murphy-administration-announces-proposed-rules-establishing-comprehensive-consumer-data-privacy-protections/"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: the statute site refused reading; only the AG's announcement of the proposed rules was opened. Whether N.J.A.C. 13:45L was adopted in 2026 is unknown.",
    "addOn": "## New Jersey residents\n\nIf you live in New Jersey, the New Jersey Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing with our reasons; if you are not satisfied, you can contact the New Jersey Division of Consumer Affairs. If we materially change how we use your data, we will update this policy and its effective date.\n"
  },
  {
    "key": "KY-kcdpa",
    "state": "KY",
    "stateName": "Kentucky",
    "lawName": "Kentucky Consumer Data Protection Act",
    "citation": "KRS 367.3611 to 367.3629",
    "appliesTo": "Businesses doing business in or targeting Kentucky that process personal data of 100,000+ Kentucky consumers a year, or 25,000+ with over 50% of revenue from selling personal data. In force January 1, 2026.",
    "coverage": "no",
    "sourceUrls": [
      "https://apps.legislature.ky.gov/law/statutes/chapter.aspx?id=39092"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Kentucky Legislature's statutes. A 2026 amendment (from July 1, 2027) covers smart-TV content recognition data, not relevant to TAWD sites.",
    "addOn": "## Kentucky residents\n\nIf you live in Kentucky, the Kentucky Consumer Data Protection Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. To make a request, email {{business.privacy_email}} or call {{business.phone}}. You don't need an account. We respond within 45 days, and may extend once by 45 more days if we tell you why. Requests are free up to twice a year. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal you can file a complaint with the Kentucky Attorney General.\n"
  },
  {
    "key": "NE-ndpa",
    "state": "NE",
    "stateName": "Nebraska",
    "lawName": "Nebraska Data Privacy Act (NDPA)",
    "citation": "Neb. Rev. Stat. §§ 87-1101 to 87-1130",
    "appliesTo": "Businesses doing business in Nebraska that are not small businesses under U.S. SBA standards; no consumer threshold. Small businesses must still get consent before selling sensitive data.",
    "coverage": "no",
    "sourceUrls": [
      "https://protectthegoodlife.nebraska.gov/data-privacy-homepage",
      "https://protectthegoodlife.nebraska.gov/controller-responsibilities",
      "https://protectthegoodlife.nebraska.gov/rights-consumers"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Nebraska AG's pages; the statute site couldn't be opened. Most local service businesses are SBA small businesses.",
    "addOn": "## Nebraska residents\n\nIf you live in Nebraska, the Nebraska Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. We will not sell sensitive personal data without your consent. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We may need to verify your identity. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply within 60 days, and if we deny your appeal you can file a complaint with the Nebraska Attorney General.\n"
  },
  {
    "key": "MD-modpa",
    "state": "MD",
    "stateName": "Maryland",
    "lawName": "Maryland Online Data Privacy Act (MODPA)",
    "citation": "Md. Code, Com. Law § 14-4701 et seq.",
    "appliesTo": "Businesses doing business in or targeting Maryland that processed personal data of 35,000+ Maryland consumers in the prior year, or 10,000+ with over 20% of revenue from selling personal data. Bans selling sensitive data outright; strict data-minimization (matters for med spas).",
    "coverage": "maybe",
    "sourceUrls": [
      "https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4705&enactments=false",
      "https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4707&enactments=false"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Maryland General Assembly's statutes. A 2026 amendment (SB 564) was seen only in a secondary source.",
    "addOn": "## Maryland residents\n\nIf you live in Maryland, the Maryland Online Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; to opt out of targeted advertising, the sale of personal data, and certain profiling; to get a list of the categories of third parties we have disclosed it to; and to withdraw any consent you gave us. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply in writing within 60 days, and if we deny your appeal you can complain to the Maryland Attorney General's Consumer Protection Division.\n"
  },
  {
    "key": "MN-mcdpa",
    "state": "MN",
    "stateName": "Minnesota",
    "lawName": "Minnesota Consumer Data Privacy Act (MCDPA)",
    "citation": "Minn. Stat. §§ 325M.10 to 325M.21",
    "appliesTo": "Businesses doing business in or targeting Minnesota that process personal data of 100,000+ Minnesota consumers a year, or 25,000+ with over 25% of revenue from selling personal data. SBA small businesses are exempt, except they may not sell sensitive data without consent.",
    "coverage": "no",
    "sourceUrls": [
      "https://www.revisor.mn.gov/statutes/cite/325M.12",
      "https://www.revisor.mn.gov/statutes/cite/325M.14",
      "https://www.revisor.mn.gov/statutes/cite/325M.16"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked on the Revisor's site. The baseline's retention sentence (Security) and effective date cover § 325M.16's retention and last-updated items.",
    "addOn": "## Minnesota residents\n\nIf you live in Minnesota, the Minnesota Consumer Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; to opt out of targeted advertising, the sale of personal data, and certain profiling; to get a list of the specific third parties we have disclosed your data to; and to question the result of certain profiling decisions. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We respond within 45 days, and may extend once by 45 more days if we tell you why. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. With our decision we will tell you how to file a complaint with the Minnesota Attorney General's Office.\n"
  },
  {
    "key": "RI-ridtppa",
    "state": "RI",
    "stateName": "Rhode Island",
    "lawName": "Rhode Island Data Transparency and Privacy Protection Act (RIDTPPA)",
    "citation": "R.I. Gen. Laws § 6-48.1-1 et seq.",
    "appliesTo": "Businesses doing business in or targeting Rhode Island that processed personal data of 35,000+ RI customers in the prior year, or 10,000+ with over 20% of revenue from selling personal data. A notice duty (§ 6-48.1-3) applies to any commercial website that sells personal information.",
    "coverage": "maybe",
    "sourceUrls": [
      "https://webserver.rilegislature.gov/Statutes/TITLE6/6-48.1/INDEX.htm"
    ],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: the Rhode Island Legislature's site refused every connection; details come from secondary sources. The appeal is offered voluntarily.",
    "addOn": "## Rhode Island residents\n\nIf you live in Rhode Island, the Rhode Island Data Transparency and Privacy Protection Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. {{business.legal_name}} does not sell personal data for money; the categories of personal data we collect and who receives it are listed above in this policy. To make a request, email {{business.privacy_email}} or call {{business.phone}}. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. You can also contact the Rhode Island Attorney General.\n"
  },
  {
    "key": "OK-ocdpa",
    "state": "OK",
    "stateName": "Oklahoma",
    "lawName": "Oklahoma Consumer Data Privacy Act (SB 546, 2026)",
    "citation": "Enrolled SB 546 (2026), Title 75A",
    "appliesTo": "From January 1, 2027: businesses doing business in or targeting Oklahoma that process personal data of 100,000+ consumers a year, or 25,000+ with over 50% of revenue from selling personal data.",
    "coverage": "no",
    "sourceUrls": [
      "http://webserver1.lsb.state.ok.us/cf_pdf/2025-26%20ENR/SB/SB546%20ENR.PDF"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked in the enrolled bill; codified section numbers not assigned yet. In force January 1, 2027.",
    "addOn": "## Oklahoma residents\n\nFrom January 1, 2027, if you live in Oklahoma, the Oklahoma Consumer Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and certain profiling. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We may need to verify your identity. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will tell you in writing what we decided and why within 60 days, and if we deny your appeal we will tell you how to complain to the Oklahoma Attorney General.\n"
  },
  {
    "key": "LA-ldpa",
    "state": "LA",
    "stateName": "Louisiana",
    "lawName": "Louisiana Data Privacy Act (SB 386, 2026)",
    "citation": "SB 386 (2026), Act No. 502; R.S. 51:1780.1 et seq. (reported)",
    "appliesTo": "From January 1, 2027 (reported): businesses doing business in Louisiana with over $25 million revenue, or processing personal data of 75,000+ consumers, households or devices, or earning 50%+ of revenue from selling personal information.",
    "coverage": "maybe",
    "sourceUrls": [],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: the Louisiana Legislature's site couldn't be reached; everything comes from secondary sources. The $25 million test can reach a larger regional company. No appeal or portability wording until verified.",
    "addOn": "## Louisiana residents\n\nFrom January 1, 2027, if you live in Louisiana, the Louisiana Data Privacy Act gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; and to opt out of targeted advertising, the sale of personal data, and certain profiling. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. We will verify your identity before acting on it.\n"
  },
  {
    "key": "AL-apdpa",
    "state": "AL",
    "stateName": "Alabama",
    "lawName": "Alabama Personal Data Protection Act (HB 351, 2026)",
    "citation": "HB 351 (2026 Regular Session), enrolled",
    "appliesTo": "From May 1, 2027: businesses doing business in or targeting Alabama that process personal data of 25,000+ consumers, or earn over 25% of revenue from selling personal data. Businesses with under 500 employees that don't sell personal data are exempt.",
    "coverage": "no",
    "sourceUrls": [
      "https://alison.legislature.state.al.us/files/pdf/SearchableInstruments/2026RS/HB351-enr.pdf"
    ],
    "checkedOn": "2026-09-28",
    "verified": true,
    "notes": "Checked in the enrolled bill; Code sections not assigned yet. No appeal duty found.",
    "addOn": "## Alabama residents\n\nFrom May 1, 2027, if you live in Alabama and the Alabama Personal Data Protection Act applies to us, you have the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; and to opt out of targeted advertising, the sale of personal data, and profiling for solely automated significant decisions. We treat a Global Privacy Control signal as a request to opt out. To make a request or opt out, email {{business.privacy_email}} or call {{business.phone}}[[IF tracking.any]], or use **Cookie settings** at the bottom of every page[[END]].\n"
  },
  {
    "key": "VT-vdposa",
    "state": "VT",
    "stateName": "Vermont",
    "lawName": "Vermont Data Privacy and Online Surveillance Act (S.71, 2026)",
    "citation": "S.71 (2026), Act No. 145 (reported)",
    "appliesTo": "Reported from January 1, 2028: businesses doing business in or targeting Vermont that processed personal data of 35,000+ consumers, or sensitive data of 3,000+, or offered personal data of 3,000+ for sale. Consumer health data rules apply to anyone, with no threshold (matters for med spas).",
    "coverage": "maybe",
    "sourceUrls": [],
    "checkedOn": "2026-09-28",
    "verified": false,
    "notes": "UNVERIFIED: the Vermont Legislature's site couldn't be reached; the effective date is reported as 2028 by most sources (one said 2027). Med spas need a separate look at the consumer health data rules.",
    "addOn": "## Vermont residents\n\nIf you live in Vermont, once the Vermont Data Privacy and Online Surveillance Act takes effect it gives you the right to confirm whether we process your personal data and to access it; to correct it; to delete it; to get a portable copy; to opt out of targeted advertising, the sale of personal data, and certain profiling; and to get a list of third parties your data was sold to. We do not collect, use or sell personal data to train large language models. We treat a Global Privacy Control signal as a request to opt out. To make a request, email {{business.privacy_email}} or call {{business.phone}}. If we decline your request, you can appeal by emailing {{business.privacy_email}} with \"Privacy appeal\" in the subject. We will reply within 60 days, and if we deny your appeal you can contact the Vermont Attorney General.\n"
  }
];
