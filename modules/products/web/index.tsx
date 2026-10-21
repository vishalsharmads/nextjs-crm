import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';

interface Product {
  uuid: string;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  unitPrice: number;
  taxRate: number;
  recurring: boolean;
  active: boolean;
}

const KEY = ['m', 'products'] as const;

function ProductDialog({
  product,
  open,
  onOpenChange,
}: {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState(() => ({
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    description: product?.description ?? '',
    unit: product?.unit ?? '',
    unitPrice: String(product?.unitPrice ?? ''),
    taxRate: String(product?.taxRate ?? 0),
    recurring: product?.recurring ?? false,
  }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...v,
        sku: v.sku || null,
        unitPrice: Number(v.unitPrice || 0),
        taxRate: Number(v.taxRate || 0),
      };
      return product
        ? apiPatch<Product>(`/m/products/products/${product.uuid}`, body)
        : apiPost<Product>('/m/products/products', body);
    },
    onSuccess: () => {
      toast.success(product ? 'Product saved' : 'Product added');
      void qc.invalidateQueries({ queryKey: KEY });
      onOpenChange(false);
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={product ? 'Edit product' : 'New product'}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!v.name.trim()}
              onClick={() => save.mutate()}
            >
              {product ? 'Save product' : 'Add product'}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (v.name.trim()) save.mutate();
          }}
        >
          <Field label="Name" required className="sm:col-span-2" error={errors.name}>
            {(p) => (
              <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
            )}
          </Field>
          <Field label="SKU" error={errors.sku} help="Optional code. Must be unique.">
            {(p) => <Input {...p} value={v.sku} onChange={(e) => setV({ ...v, sku: e.target.value })} />}
          </Field>
          <Field label="Unit" help="For example hour, day, month or item.">
            {(p) => <Input {...p} value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} />}
          </Field>
          <Field label="Unit price" error={errors.unitPrice}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={v.unitPrice}
                onChange={(e) => setV({ ...v, unitPrice: e.target.value })}
              />
            )}
          </Field>
          <Field label="Tax %" error={errors.taxRate}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                step="0.001"
                min={0}
                max={100}
                value={v.taxRate}
                onChange={(e) => setV({ ...v, taxRate: e.target.value })}
              />
            )}
          </Field>
          <Field label="Description" className="sm:col-span-2" help="Copied onto quote and invoice lines.">
            {(p) => (
              <Textarea
                {...p}
                value={v.description}
                onChange={(e) => setV({ ...v, description: e.target.value })}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={v.recurring}
              onChange={(e) => setV({ ...v, recurring: e.target.checked })}
              className="size-4 accent-primary"
            />
            Billed on a recurring basis
          </label>
          <button type="submit" hidden />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductsPage() {
  const can = useCan();
  const qc = useQueryClient();
  const manage = can('products.products.manage');
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'true' | 'false' | 'all'>('true');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const list = useQuery({
    queryKey: [...KEY, q, active],
    queryFn: () =>
      apiGet<{ data: Product[]; meta: { total: number } }>('/m/products/products', {
        q,
        active,
        pageSize: 100,
      }),
    placeholderData: keepPreviousData,
  });
  const toggle = useMutation({
    mutationFn: (p: Product) => apiPatch(`/m/products/products/${p.uuid}`, { active: !p.active }),
    onSuccess: (_d, p) => {
      toast.success(p.active ? 'Product archived' : 'Product restored');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });

  return (
    <div>
      <PageHeader
        title="Products"
        description="What you sell. Products fill in quote and invoice lines with their price and tax."
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus /> New product
            </Button>
          ) : null
        }
      />
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-2 size-4 text-faint" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or SKU"
              aria-label="Search products"
              className="ps-8"
            />
          </div>
          <NativeSelect
            value={active}
            onChange={(e) => setActive(e.target.value as typeof active)}
            aria-label="Show"
            className="w-36"
          >
            <option value="true">Active</option>
            <option value="false">Archived</option>
            <option value="all">All</option>
          </NativeSelect>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.data.length ? (
          <EmptyState
            icon={<Package />}
            title={q || active !== 'true' ? 'No products match' : 'No products yet'}
            description={
              manage && !q ? 'Add what you sell so quotes and invoices fill themselves in.' : undefined
            }
            action={
              manage && !q ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  <Plus /> New product
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">Name</th>
                  <th className="px-4 py-2 text-start font-medium">SKU</th>
                  <th className="px-4 py-2 text-end font-medium">Price</th>
                  <th className="px-4 py-2 text-end font-medium">Tax</th>
                  <th className="w-32" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((p) => (
                  <tr key={p.uuid} className="border-b border-line last:border-0 hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        className="text-start font-medium hover:underline disabled:no-underline"
                        onClick={() => setEditing(p)}
                        disabled={!manage}
                      >
                        {p.name}
                      </button>
                      <span className="ms-2 inline-flex gap-1">
                        {p.recurring ? <Badge tone="primary">Recurring</Badge> : null}
                        {!p.active ? <Badge>Archived</Badge> : null}
                      </span>
                      {p.description ? (
                        <p className="line-clamp-1 text-xs text-muted">{p.description}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{p.sku ?? '—'}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatMoney(p.unitPrice)}
                      {p.unit ? <span className="text-muted"> / {p.unit}</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{p.taxRate ? `${p.taxRate}%` : '—'}</td>
                    <td className="px-4 py-2.5 text-end">
                      {manage ? (
                        <Button size="sm" variant="ghost" onClick={() => toggle.mutate(p)}>
                          {p.active ? 'Archive' : 'Restore'}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing ? (
        <ProductDialog
          key={editing === 'new' ? 'new' : editing.uuid}
          product={editing === 'new' ? null : editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      ) : null}
    </div>
  );
}

const productsModule: WebModule = {
  key: 'products',
  routes: [{ path: '', element: <ProductsPage /> }],
};

export default productsModule;
