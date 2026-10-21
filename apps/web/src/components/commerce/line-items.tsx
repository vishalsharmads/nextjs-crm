import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { documentTotals, lineTotals } from '@app/shared';
import { apiGet } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RecordPicker } from '@/components/fields/pickers';

export interface EditableLine {
  key: string;
  productUuid: string | null;
  productName?: string | null;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
}

interface Product {
  uuid: string;
  name: string;
  description: string | null;
  unitPrice: number;
  taxRate: number;
}

let seq = 0;
export const newLine = (taxRate = 0): EditableLine => ({
  key: `l${seq++}`,
  productUuid: null,
  name: '',
  description: '',
  quantity: 1,
  unitPrice: 0,
  discountPct: 0,
  taxRate,
});

export interface LineDto {
  productUuid: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  net: number;
  tax: number;
  total: number;
}

export const toEditable = (lines: LineDto[]): EditableLine[] =>
  lines.map((l) => ({
    ...newLine(),
    productUuid: l.productUuid,
    productName: l.productUuid ? l.name : null,
    name: l.name,
    description: l.description ?? '',
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discountPct: l.discountPct,
    taxRate: l.taxRate,
  }));

/** The shape the API accepts (it recomputes totals itself). */
export const toInput = (lines: EditableLine[]) =>
  lines
    .filter((l) => l.name.trim())
    .map(({ productUuid, name, description, quantity, unitPrice, discountPct, taxRate }) => ({
      productUuid,
      name,
      description: description || null,
      quantity,
      unitPrice,
      discountPct,
      taxRate,
    }));

const num = (v: string) => (v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

/** Editable line items with live totals (same math as the server). */
export function LineItemsEditor({
  lines,
  onChange,
  currency,
  canUseProducts,
  defaultTaxRate,
}: {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  currency: string;
  canUseProducts: boolean;
  defaultTaxRate: number;
}) {
  const id = useId();
  const set = (key: string, patch: Partial<EditableLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickProduct = async (key: string, uuid: string | null) => {
    if (!uuid) return set(key, { productUuid: null, productName: null });
    const p = await apiGet<Product>(`/m/products/products/${uuid}`);
    set(key, {
      productUuid: p.uuid,
      productName: p.name,
      name: p.name,
      description: p.description ?? '',
      unitPrice: p.unitPrice,
      taxRate: p.taxRate,
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-subtle text-xs text-muted">
            <tr>
              <th className="px-3 py-2 text-start font-medium">Item</th>
              <th className="w-20 px-2 py-2 text-end font-medium">Qty</th>
              <th className="w-28 px-2 py-2 text-end font-medium">Unit price</th>
              <th className="w-20 px-2 py-2 text-end font-medium">Disc. %</th>
              <th className="w-20 px-2 py-2 text-end font-medium">Tax %</th>
              <th className="w-28 px-3 py-2 text-end font-medium">Amount</th>
              <th className="w-10" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key} className="border-t border-line align-top">
                <td className="flex flex-col gap-1.5 px-3 py-2">
                  {canUseProducts ? (
                    <RecordPicker
                      route="m/products/products"
                      value={l.productUuid}
                      label={l.productName ?? (l.productUuid ? l.name : null)}
                      onChange={(uuid) => void pickProduct(l.key, uuid)}
                      placeholder="Pick a product, or type below"
                      aria-label={`Product for line ${i + 1}`}
                    />
                  ) : null}
                  <Input
                    value={l.name}
                    onChange={(e) => set(l.key, { name: e.target.value })}
                    placeholder="Name"
                    aria-label={`Name for line ${i + 1}`}
                    id={i === 0 ? `${id}-first` : undefined}
                  />
                  <Input
                    value={l.description}
                    onChange={(e) => set(l.key, { description: e.target.value })}
                    placeholder="Description (optional)"
                    aria-label={`Description for line ${i + 1}`}
                    className="text-xs"
                  />
                </td>
                {(
                  [
                    ['quantity', 'Quantity', '0.01'],
                    ['unitPrice', 'Unit price', '0.01'],
                    ['discountPct', 'Discount percent', '0.01'],
                    ['taxRate', 'Tax percent', '0.001'],
                  ] as const
                ).map(([field, label, step]) => (
                  <td key={field} className="px-2 py-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      step={step}
                      min={field === 'unitPrice' ? undefined : 0}
                      value={String(l[field])}
                      onChange={(e) => set(l.key, { [field]: num(e.target.value) })}
                      aria-label={`${label} for line ${i + 1}`}
                      className="text-end tabular-nums"
                    />
                  </td>
                ))}
                <td className="px-3 py-3.5 text-end tabular-nums">
                  {formatMoney(lineTotals(l).net, currency, true)}
                </td>
                <td className="py-2 pe-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Button type="button" onClick={() => onChange([...lines, newLine(defaultTaxRate)])}>
          <Plus /> Add line
        </Button>
        <TotalsSummary lines={lines} currency={currency} />
      </div>
    </div>
  );
}

export function TotalsSummary({
  lines,
  currency,
  extra,
}: {
  lines: { quantity: number; unitPrice: number; discountPct: number; taxRate: number }[];
  currency: string;
  extra?: { label: string; value: number; strong?: boolean }[];
}) {
  const t = documentTotals(lines);
  const rows: { label: string; value: number; strong?: boolean }[] = [
    { label: 'Subtotal', value: t.subtotal },
  ];
  if (t.discount) rows.push({ label: 'Discount', value: -t.discount });
  for (const tax of t.taxes) rows.push({ label: `Tax ${tax.rate}%`, value: tax.tax });
  rows.push({ label: 'Total', value: t.total, strong: true });
  return (
    <dl className="grid min-w-64 grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
      {[...rows, ...(extra ?? [])].map((r) => (
        <div key={r.label} className="contents">
          <dt className={r.strong ? 'font-semibold' : 'text-muted'}>{r.label}</dt>
          <dd className={`text-end tabular-nums ${r.strong ? 'font-semibold' : ''}`}>
            {formatMoney(r.value, currency, true)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
