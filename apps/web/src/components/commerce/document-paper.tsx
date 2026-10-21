import type { ReactNode } from 'react';
import type { CommerceSettings } from '@app/shared';
import { useBranding } from '@/app/branding';
import { formatDate, formatMoney } from '@/lib/format';
import { TotalsSummary, type LineDto } from './line-items';

export interface RecordRef {
  uuid: string;
  name: string;
}

/**
 * A quote, invoice or contract as the customer sees it. Uses theme tokens only, and prints cleanly
 * (the app shell hides itself in print), so "Print" or "Save as PDF" from the browser is the PDF.
 */
export function DocumentPaper({
  kind,
  business,
  partyLabel = 'Prepared for',
  number,
  title,
  badge,
  organization,
  contact,
  dates,
  currency,
  lines,
  extraTotals,
  notes,
  terms,
  footer,
}: {
  kind: string;
  /** Business details printed in the header (settings → sales documents). */
  business: Pick<CommerceSettings, 'legalName' | 'address' | 'taxId' | 'email' | 'phone'>;
  partyLabel?: string;
  number: string;
  title?: string;
  badge?: ReactNode;
  organization: RecordRef | null;
  contact: RecordRef | null;
  dates: { label: string; value: string | null }[];
  currency: string;
  lines: LineDto[];
  extraTotals?: { label: string; value: number; strong?: boolean }[];
  notes?: string | null;
  terms?: string | null;
  footer?: ReactNode;
}) {
  const { branding } = useBranding();
  const company = business;
  const logo = branding.assets.logoLight;
  return (
    <article className="mx-auto w-full max-w-4xl rounded-md border border-line bg-surface p-6 text-sm shadow-sm md:p-10 print:max-w-none print:border-0 print:p-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-line pb-6">
        <div className="min-w-0">
          {logo ? (
            <img src={logo} alt={branding.appName} className="mb-3 h-8 w-auto" />
          ) : (
            <p className="mb-1 text-lg font-semibold">{company.legalName || branding.appName}</p>
          )}
          {logo && company.legalName ? <p className="font-medium">{company.legalName}</p> : null}
          {company.address ? <p className="whitespace-pre-line text-muted">{company.address}</p> : null}
          <p className="text-muted">{[company.email, company.phone].filter(Boolean).join(' · ')}</p>
          {company.taxId ? <p className="text-muted">Tax ID: {company.taxId}</p> : null}
        </div>
        <div className="text-end">
          <p className="text-2xl font-semibold tracking-tight">{kind}</p>
          <p className="font-mono text-muted">{number}</p>
          {badge ? <div className="mt-2 print:hidden">{badge}</div> : null}
        </div>
      </header>

      <section className="grid gap-6 py-6 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">{partyLabel}</p>
          {organization ? <p className="mt-1 font-medium">{organization.name}</p> : null}
          {contact ? (
            <p className={organization ? 'text-muted' : 'mt-1 font-medium'}>{contact.name}</p>
          ) : null}
          {!organization && !contact ? <p className="mt-1 text-muted">Not set</p> : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:justify-self-end">
          {dates
            .filter((d) => d.value)
            .map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted">{d.label}</dt>
                <dd className="text-end">{formatDate(d.value)}</dd>
              </div>
            ))}
        </dl>
      </section>

      {title ? <h2 className="mb-3 text-base font-semibold">{title}</h2> : null}

      <table className="w-full text-sm">
        <thead className="border-y border-line text-xs text-muted">
          <tr>
            <th className="py-2 text-start font-medium">Item</th>
            <th className="py-2 text-end font-medium">Qty</th>
            <th className="py-2 text-end font-medium">Unit price</th>
            <th className="hidden py-2 text-end font-medium sm:table-cell print:table-cell">Tax</th>
            <th className="py-2 text-end font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-b border-line align-top">
              <td className="py-2.5 pe-4">
                <p className="font-medium">{l.name}</p>
                {l.description ? (
                  <p className="whitespace-pre-line text-xs text-muted">{l.description}</p>
                ) : null}
                {l.discountPct ? <p className="text-xs text-muted">{l.discountPct}% discount</p> : null}
              </td>
              <td className="py-2.5 text-end tabular-nums">{l.quantity}</td>
              <td className="py-2.5 text-end tabular-nums">{formatMoney(l.unitPrice, currency, true)}</td>
              <td className="hidden py-2.5 text-end tabular-nums sm:table-cell print:table-cell">
                {l.taxRate ? `${l.taxRate}%` : '—'}
              </td>
              <td className="py-2.5 text-end tabular-nums">{formatMoney(l.net, currency, true)}</td>
            </tr>
          ))}
          {!lines.length ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-muted">
                No lines yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <div className="flex justify-end pt-4">
        <TotalsSummary lines={lines} currency={currency} extra={extraTotals} />
      </div>

      {notes || terms || footer ? (
        <footer className="mt-8 grid gap-6 border-t border-line pt-6 sm:grid-cols-2">
          {notes ? (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted uppercase">Notes</p>
              <p className="mt-1 whitespace-pre-line">{notes}</p>
            </div>
          ) : null}
          {terms ? (
            <div>
              <p className="text-xs font-medium tracking-wide text-muted uppercase">Terms</p>
              <p className="mt-1 whitespace-pre-line">{terms}</p>
            </div>
          ) : null}
          {footer}
        </footer>
      ) : null}
    </article>
  );
}
