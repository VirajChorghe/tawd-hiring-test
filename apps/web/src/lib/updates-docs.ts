import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { project } from "@tawd/core/schema";
import { dayLabel } from "@/lib/pricing";
import { UpdatesError, invoiceCsv, loadInvoice, loadQuotes } from "@/lib/updates";

/*
  The quote and the month's invoice as clean pages for the client (Updates,
  1 October 2026): opened in the browser, then printed or saved as PDF. No
  AI costs, no team names, no internal notes. Code only, $0.
*/

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (cents: number | null) => (cents === null ? "Price to be confirmed" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  body { margin: 0; background: #f4f5f2; color: #18212b; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 820px; margin: 32px auto; background: #fff; border: 1px solid #dde1e4; border-radius: 12px; padding: 40px 48px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .muted { color: #5b6570; font-size: 14px; margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 24px 0 8px; }
  th { text-align: left; font-size: 13px; color: #5b6570; font-weight: 600; border-bottom: 2px solid #dde1e4; padding: 8px 6px; }
  td { border-bottom: 1px solid #dde1e4; padding: 10px 6px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .total td { border-bottom: 0; font-weight: 700; font-size: 17px; }
  .print { margin: 16px auto 0; max-width: 820px; text-align: right; }
  button { font: 600 14px "Segoe UI", system-ui, sans-serif; min-height: 40px; padding: 0 16px; border-radius: 8px; border: 1px solid #205af2; background: #205af2; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } main { border: 0; margin: 0; max-width: none; padding: 0; } .print { display: none; } }
</style>
</head>
<body>
<div class="print"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<main>${body}</main>
</body>
</html>`;
}

async function clientName(db: Database, projectId: string): Promise<string> {
  const [row] = await db.select({ name: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new UpdatesError("That project no longer exists.");
  return row.name;
}

export async function quoteDocument(db: Database, projectId: string, quoteId: string): Promise<string> {
  const name = await clientName(db, projectId);
  const quote = (await loadQuotes(db, projectId)).find((q) => q.id === quoteId);
  if (!quote) throw new UpdatesError("That quote is no longer here.");
  const rows = quote.lines
    .map((l) => `<tr><td>${escape(l.label)}</td><td class="num">${l.quantity}</td><td class="num">${money(l.unitCents)}</td><td class="num">${money(l.amountCents)}</td></tr>`)
    .join("");
  return page(
    `Quote for ${name}`,
    `<h1>Quote: ${escape(name)}</h1>
<p class="muted">From Velocity Media Lab, ${escape(dayLabel(quote.createdAt))}</p>
<p style="margin-top:20px">You asked: &ldquo;${escape(quote.request)}&rdquo;${quote.requestedOn ? ` (${escape(dayLabel(quote.requestedOn))})` : ""}</p>
<table><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
<tbody>${rows}<tr class="total"><td colspan="3">Total</td><td class="num">${money(quote.totalCents)}</td></tr></tbody></table>
<p class="muted">Work starts once you approve this quote.</p>`,
  );
}

export async function invoiceDocument(db: Database, projectId: string, month: string): Promise<string> {
  const name = await clientName(db, projectId);
  const invoice = await loadInvoice(db, projectId, month);
  if (!invoice) throw new UpdatesError("This month's invoice isn't saved yet.");
  const monthName = new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const rows = invoice.lines
    .map((l) => `<tr><td>${escape(dayLabel(l.date))}</td><td>${escape(l.task)}</td><td>${escape(l.category)}</td><td class="num">${l.hours || ""}</td><td class="num">${money(l.amountCents)}</td></tr>`)
    .join("");
  const hours = Math.round(invoice.lines.reduce((n, l) => n + l.hours, 0) * 100) / 100;
  return page(
    `Invoice for ${name}, ${monthName}`,
    `<h1>Invoice: ${escape(name)}</h1>
<p class="muted">Website updates, ${escape(monthName)}. From Velocity Media Lab.</p>
<table><thead><tr><th>Date</th><th>Task</th><th>Category</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead>
<tbody>${rows}<tr class="total"><td colspan="3">Total</td><td class="num">${hours || ""}</td><td class="num">${money(invoice.totalCents)}</td></tr></tbody></table>`,
  );
}

export async function invoiceCsvFile(db: Database, projectId: string, month: string): Promise<{ csv: string; fileName: string }> {
  const name = await clientName(db, projectId);
  const invoice = await loadInvoice(db, projectId, month);
  if (!invoice) throw new UpdatesError("This month's invoice isn't saved yet.");
  return { csv: invoiceCsv(name, month, invoice.lines), fileName: `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}-invoice-${month}.csv` };
}
