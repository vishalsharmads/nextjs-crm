import { z } from 'zod';

/**
 * Line-item math shared by the API (source of truth) and the web (live preview), so both always agree.
 * Money is computed in integer minor units (cents) and rounded half away from zero per line,
 * then summed: the printed lines always add up to the printed total.
 */

export const lineItemInput = z.object({
  productUuid: z.uuid().nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  quantity: z.coerce.number().positive().max(1_000_000),
  unitPrice: z.coerce.number().min(-100_000_000).max(100_000_000),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(0),
});
export type LineItemInput = z.input<typeof lineItemInput>;

export interface LineTotals {
  subtotal: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

export interface DocumentTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** Tax per rate, for the summary block on printed documents. */
  taxes: { rate: number; net: number; tax: number }[];
}

const cents = (v: number) => Math.sign(v) * Math.round(Math.abs(v) * 100);
const fromCents = (c: number) => c / 100;

export function lineTotals(l: {
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number;
}): LineTotals {
  const subtotal = cents(l.quantity * l.unitPrice);
  const discount = Math.sign(subtotal) * Math.round((Math.abs(subtotal) * (l.discountPct ?? 0)) / 100);
  const net = subtotal - discount;
  const tax = Math.sign(net) * Math.round((Math.abs(net) * (l.taxRate ?? 0)) / 100);
  return {
    subtotal: fromCents(subtotal),
    discount: fromCents(discount),
    net: fromCents(net),
    tax: fromCents(tax),
    total: fromCents(net + tax),
  };
}

export function documentTotals(
  lines: { quantity: number; unitPrice: number; discountPct?: number; taxRate?: number }[],
): DocumentTotals {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const byRate = new Map<number, { net: number; tax: number }>();
  for (const l of lines) {
    const t = lineTotals(l);
    subtotal += cents(t.subtotal);
    discount += cents(t.discount);
    tax += cents(t.tax);
    const rate = l.taxRate ?? 0;
    const r = byRate.get(rate) ?? { net: 0, tax: 0 };
    r.net += cents(t.net);
    r.tax += cents(t.tax);
    byRate.set(rate, r);
  }
  return {
    subtotal: fromCents(subtotal),
    discount: fromCents(discount),
    tax: fromCents(tax),
    total: fromCents(subtotal - discount + tax),
    taxes: [...byRate.entries()]
      .filter(([rate]) => rate > 0)
      .sort(([a], [b]) => a - b)
      .map(([rate, r]) => ({ rate, net: fromCents(r.net), tax: fromCents(r.tax) })),
  };
}

/** Subtract in cents (balance due = total − paid) without float drift. */
export const subtractMoney = (a: number, b: number) => fromCents(cents(a) - cents(b));
export const addMoney = (a: number, b: number) => fromCents(cents(a) + cents(b));

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'card', 'cash', 'cheque', 'other'] as const;

export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'cancelled', 'renewed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Next number from a prefix and counter, e.g. ("Q-", 7, 4) → "Q-0007". */
export const formatDocNumber = (prefix: string, n: number, pad = 4) =>
  `${prefix}${String(n).padStart(pad, '0')}`;
