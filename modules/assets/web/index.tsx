import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Plus,
  Search,
  SlidersHorizontal,
  Undo2,
  UserRoundPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';

interface Ref {
  uuid: string;
  name: string;
}
interface Asset {
  uuid: string;
  tag: string;
  name: string;
  category: string;
  serial: string;
  location: string;
  status: 'available' | 'assigned' | 'maintenance' | 'retired';
  assignedTo: Ref | null;
  assignedAt: string | null;
  dueBack: string | null;
  overdue: boolean;
  purchasedOn: string | null;
  purchaseCost: number | null;
  notes: string | null;
  history?: { kind: string; contact: Ref | null; note: string | null; by: Ref | null; at: string }[];
}
interface Stock {
  uuid: string;
  sku: string | null;
  name: string;
  unit: string;
  location: string;
  quantity: number;
  reorderLevel: number | null;
  low: boolean;
  movements?: {
    kind: string;
    quantity: number;
    balanceAfter: number;
    reason: string | null;
    by: Ref | null;
    at: string;
  }[];
}

const ROOT = '/m/assets';
const KEY = ['m', 'assets'] as const;
const STATUS: Record<Asset['status'], string> = {
  available: 'Available',
  assigned: 'Lent out',
  maintenance: 'In maintenance',
  retired: 'Retired',
};
const HISTORY: Record<string, string> = {
  created: 'Added',
  assigned: 'Lent to',
  returned: 'Returned by',
  maintenance: 'Sent for maintenance',
  available: 'Back in service',
  retired: 'Retired',
  note: 'Note',
};

function useNouns() {
  const L = labelVars(useBoot().labels);
  return {
    asset: L.asset ?? 'Asset',
    assets: L.assetPlural ?? 'Assets',
    stock: L.stockItem ?? 'Stock item',
    stocks: L.stockItemPlural ?? 'Stock items',
    contact: L.contact ?? 'Contact',
  };
}

function AssetStatus({ a }: { a: Pick<Asset, 'status' | 'overdue'> }) {
  if (a.overdue) return <Badge tone="accent">Overdue</Badge>;
  return (
    <Badge tone={a.status === 'available' ? 'primary' : a.status === 'assigned' ? 'outline' : 'neutral'}>
      {STATUS[a.status]}
    </Badge>
  );
}

const refresh = (qc: ReturnType<typeof useQueryClient>) => void qc.invalidateQueries({ queryKey: KEY });

function AssetDialog({ asset, onDone }: { asset: Asset | null; onDone: () => void }) {
  const qc = useQueryClient();
  const nouns = useNouns();
  const [v, setV] = useState({
    tag: asset?.tag ?? '',
    name: asset?.name ?? '',
    category: asset?.category ?? '',
    serial: asset?.serial ?? '',
    location: asset?.location ?? '',
    purchasedOn: asset?.purchasedOn ?? '',
    purchaseCost: asset?.purchaseCost ? String(asset.purchaseCost) : '',
    notes: asset?.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...v,
        purchasedOn: v.purchasedOn || null,
        purchaseCost: v.purchaseCost ? Number(v.purchaseCost) : null,
        notes: v.notes || null,
      };
      return asset ? apiPatch(`${ROOT}/assets/${asset.uuid}`, body) : apiPost(`${ROOT}/assets`, body);
    },
    onSuccess: () => {
      toast.success(asset ? 'Saved' : `${nouns.asset} added`);
      refresh(qc);
      onDone();
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={asset ? `Edit ${asset.tag}` : `New ${nouns.asset.toLowerCase()}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v.tag.trim() || !v.name.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tag" required error={errors.tag} help="A unique label, for example KEY-014.">
            {(p) => (
              <Input {...p} value={v.tag} onChange={(e) => setV({ ...v, tag: e.target.value })} autoFocus />
            )}
          </Field>
          <Field label="Name" required>
            {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}
          </Field>
          <Field label="Category">
            {(p) => (
              <Input {...p} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} />
            )}
          </Field>
          <Field label="Serial number">
            {(p) => (
              <Input {...p} value={v.serial} onChange={(e) => setV({ ...v, serial: e.target.value })} />
            )}
          </Field>
          <Field label="Location">
            {(p) => (
              <Input {...p} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} />
            )}
          </Field>
          <Field label="Purchased on">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={v.purchasedOn}
                onChange={(e) => setV({ ...v, purchasedOn: e.target.value })}
              />
            )}
          </Field>
          <Field label="Purchase cost">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="0.01"
                value={v.purchaseCost}
                onChange={(e) => setV({ ...v, purchaseCost: e.target.value })}
              />
            )}
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={v.notes}
                onChange={(e) => setV({ ...v, notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LendDialog({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const qc = useQueryClient();
  const nouns = useNouns();
  const [who, setWho] = useState<Ref | null>(null);
  const [dueBack, setDueBack] = useState('');
  const lend = useMutation({
    mutationFn: () =>
      apiPost(`${ROOT}/assets/${asset.uuid}/assign`, { contactUuid: who!.uuid, dueBack: dueBack || null }),
    onSuccess: () => {
      toast.success(`Lent to ${who!.name}`);
      refresh(qc);
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`Lend ${asset.tag}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!who} loading={lend.isPending} onClick={() => lend.mutate()}>
              Lend
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={nouns.contact} required>
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={who?.uuid ?? null}
                label={who?.name}
                onChange={(uuid, name) => setWho(uuid ? { uuid, name: name ?? '' } : null)}
              />
            )}
          </Field>
          <Field label="Due back" help="Optional. Overdue items are flagged.">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={dueBack}
                onChange={(e) => setDueBack(e.target.value)}
                className="w-44"
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AssetsTab() {
  const can = useCan();
  const qc = useQueryClient();
  const nouns = useNouns();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'lend'; asset: Asset | null } | null>(null);
  const list = useQuery({
    queryKey: [...KEY, 'assets', q, status, category],
    queryFn: () =>
      apiGet<{ data: Asset[]; categories: string[] }>(`${ROOT}/assets`, {
        q,
        status: status || undefined,
        category: category || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const giveBack = useMutation({
    mutationFn: ({ a, needsMaintenance }: { a: Asset; needsMaintenance: boolean }) =>
      apiPost(`${ROOT}/assets/${a.uuid}/return`, { needsMaintenance }),
    onSuccess: () => {
      toast.success('Returned');
      refresh(qc);
    },
  });
  const manage = can('assets.assets.manage');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-2 size-4 text-faint" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tag, name or serial"
            aria-label="Search"
            className="ps-8"
          />
        </div>
        <NativeSelect
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
          className="w-44"
        >
          <option value="">In use or available</option>
          <option value="available">Available</option>
          <option value="assigned">Lent out</option>
          <option value="overdue">Overdue</option>
          <option value="maintenance">In maintenance</option>
          <option value="retired">Retired</option>
        </NativeSelect>
        {list.data?.categories.length ? (
          <NativeSelect
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className="w-40"
          >
            <option value="">All categories</option>
            {list.data.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </NativeSelect>
        ) : null}
        {manage ? (
          <Button variant="primary" onClick={() => setDialog({ kind: 'edit', asset: null })}>
            <Plus /> New {nouns.asset.toLowerCase()}
          </Button>
        ) : null}
      </div>
      {list.isPending ? (
        <Skeleton className="h-64" />
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : !list.data.data.length ? (
        <EmptyState
          icon={<Box />}
          title={`No ${nouns.assets.toLowerCase()} here`}
          description={!q && !status ? 'Add keys, equipment and anything else you lend out.' : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-line bg-subtle text-xs text-muted">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Tag</th>
                <th className="px-4 py-2 text-start font-medium">Name</th>
                <th className="px-4 py-2 text-start font-medium">Status</th>
                <th className="px-4 py-2 text-start font-medium">With</th>
                <th className="w-48" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((a) => (
                <tr key={a.uuid} className="border-b border-line last:border-0 hover:bg-hover">
                  <td className="px-4 py-2.5 font-mono">
                    <Link to={`${ROOT}/${a.uuid}`} className="hover:underline">
                      {a.tag}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    {a.name}
                    {a.category ? <span className="block text-xs text-muted">{a.category}</span> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <AssetStatus a={a} />
                  </td>
                  <td className="px-4 py-2.5">
                    {a.assignedTo ? (
                      <>
                        <Link to={`/contacts/${a.assignedTo.uuid}`} className="hover:underline">
                          {a.assignedTo.name}
                        </Link>
                        {a.dueBack ? (
                          <span className="block text-xs text-muted">due {formatDate(a.dueBack)}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted">{a.location || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    {manage && a.status === 'available' ? (
                      <Button size="sm" onClick={() => setDialog({ kind: 'lend', asset: a })}>
                        <UserRoundPlus /> Lend
                      </Button>
                    ) : null}
                    {manage && a.status === 'assigned' ? (
                      <Button size="sm" onClick={() => giveBack.mutate({ a, needsMaintenance: false })}>
                        <Undo2 /> Return
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog?.kind === 'edit' ? <AssetDialog asset={dialog.asset} onDone={() => setDialog(null)} /> : null}
      {dialog?.kind === 'lend' && dialog.asset ? (
        <LendDialog asset={dialog.asset} onDone={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function MovementDialog({
  item,
  kind,
  onDone,
}: {
  item: Stock;
  kind: 'in' | 'out' | 'adjust';
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [quantity, setQuantity] = useState(kind === 'adjust' ? String(item.quantity) : '');
  const [reason, setReason] = useState('');
  const move = useMutation({
    mutationFn: () =>
      apiPost(`${ROOT}/stock/${item.uuid}/movements`, {
        kind,
        quantity: Number(quantity),
        reason: reason || null,
      }),
    onSuccess: () => {
      toast.success(kind === 'in' ? 'Stock added' : kind === 'out' ? 'Stock used' : 'Count saved');
      refresh(qc);
      onDone();
    },
  });
  const errors = move.error instanceof ApiError ? move.error.fieldErrors() : {};
  const title =
    kind === 'in' ? `Add ${item.name}` : kind === 'out' ? `Use ${item.name}` : `Count ${item.name}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={title}
        description={`${item.quantity} ${item.unit} in stock now.`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={quantity === ''}
              loading={move.isPending}
              onClick={() => move.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={kind === 'adjust' ? 'Counted quantity' : 'Quantity'} required error={errors.quantity}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                autoFocus
                className="w-40"
              />
            )}
          </Field>
          <Field label="Reason">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewStockDialog({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const nouns = useNouns();
  const [v, setV] = useState({ name: '', sku: '', unit: '', location: '', quantity: '', reorderLevel: '' });
  const create = useMutation({
    mutationFn: () =>
      apiPost(`${ROOT}/stock`, {
        ...v,
        sku: v.sku || null,
        quantity: Number(v.quantity || 0),
        reorderLevel: v.reorderLevel === '' ? null : Number(v.reorderLevel),
      }),
    onSuccess: () => {
      toast.success(`${nouns.stock} added`);
      refresh(qc);
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`New ${nouns.stock.toLowerCase()}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v.name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2">
            {(p) => (
              <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
            )}
          </Field>
          <Field label="Unit" help="For example kg, box or pack.">
            {(p) => <Input {...p} value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} />}
          </Field>
          <Field label="SKU">
            {(p) => <Input {...p} value={v.sku} onChange={(e) => setV({ ...v, sku: e.target.value })} />}
          </Field>
          <Field label="Opening quantity">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="any"
                value={v.quantity}
                onChange={(e) => setV({ ...v, quantity: e.target.value })}
              />
            )}
          </Field>
          <Field label="Reorder at" help="Warn when stock falls to this level.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="any"
                value={v.reorderLevel}
                onChange={(e) => setV({ ...v, reorderLevel: e.target.value })}
              />
            )}
          </Field>
          <Field label="Location" className="sm:col-span-2">
            {(p) => (
              <Input {...p} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StockTab() {
  const can = useCan();
  const nouns = useNouns();
  const [lowOnly, setLowOnly] = useState(false);
  const [dialog, setDialog] = useState<{ item: Stock; kind: 'in' | 'out' | 'adjust' } | 'new' | null>(null);
  const list = useQuery({
    queryKey: [...KEY, 'stock', lowOnly],
    queryFn: () =>
      apiGet<{ data: Stock[] }>(`${ROOT}/stock`, lowOnly ? { low: 'true' } : {}).then((r) => r.data),
  });
  const manage = can('assets.stock.manage');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="size-4 accent-primary"
          />
          Only items running low
        </label>
        {manage ? (
          <Button variant="primary" className="ms-auto" onClick={() => setDialog('new')}>
            <Plus /> New {nouns.stock.toLowerCase()}
          </Button>
        ) : null}
      </div>
      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <ErrorState error={list.error} />
      ) : !list.data.length ? (
        <EmptyState
          icon={<Box />}
          title={lowOnly ? 'Nothing is running low' : `No ${nouns.stocks.toLowerCase()} yet`}
        />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {list.data.map((s) => (
            <li key={s.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{s.name}</span>
                <span className="text-xs text-muted">
                  {[s.sku, s.location, s.reorderLevel !== null ? `reorder at ${s.reorderLevel}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {s.low ? <Badge tone="accent">Low</Badge> : null}
              <span className="w-28 text-end font-medium tabular-nums">
                {s.quantity} {s.unit}
              </span>
              {manage ? (
                <span className="flex gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Add ${s.name}`}
                    onClick={() => setDialog({ item: s, kind: 'in' })}
                  >
                    <ArrowDownToLine />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Use ${s.name}`}
                    onClick={() => setDialog({ item: s, kind: 'out' })}
                  >
                    <ArrowUpFromLine />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Count ${s.name}`}
                    onClick={() => setDialog({ item: s, kind: 'adjust' })}
                  >
                    <SlidersHorizontal />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {dialog === 'new' ? <NewStockDialog onDone={() => setDialog(null)} /> : null}
      {dialog && dialog !== 'new' ? (
        <MovementDialog item={dialog.item} kind={dialog.kind} onDone={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function InventoryHome() {
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stock' ? 'stock' : 'assets';
  return (
    <div>
      <PageHeader title="Inventory">
        <nav className="-mb-px flex gap-1" aria-label="Sections">
          {(
            [
              ['assets', nouns.assets],
              ['stock', 'Stock'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setParams(k === 'assets' ? {} : { tab: k })}
              aria-current={tab === k ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {label}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="mx-auto max-w-6xl p-4 md:p-6">{tab === 'assets' ? <AssetsTab /> : <StockTab />}</div>
    </div>
  );
}

function AssetPage() {
  const { uuid = '' } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'lend' | null>(null);
  const asset = useQuery({
    queryKey: [...KEY, 'asset', uuid],
    queryFn: () => apiGet<Asset>(`${ROOT}/assets/${uuid}`),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => apiPost(`${ROOT}/assets/${uuid}/status`, { status }),
    onSuccess: () => {
      toast.success('Updated');
      refresh(qc);
    },
  });
  const giveBack = useMutation({
    mutationFn: (needsMaintenance: boolean) => apiPost(`${ROOT}/assets/${uuid}/return`, { needsMaintenance }),
    onSuccess: () => {
      toast.success('Returned');
      refresh(qc);
    },
  });
  if (asset.isPending) return <Skeleton className="m-6 h-64" />;
  if (asset.isError) return <ErrorState error={asset.error} />;
  const a = asset.data;
  const manage = can('assets.assets.manage');
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{a.tag}</span> {a.name} <AssetStatus a={a} />
          </span>
        }
        description={
          <Link to={ROOT} className="text-primary hover:underline">
            ← Inventory
          </Link>
        }
        actions={
          manage ? (
            <>
              <Button onClick={() => setDialog('edit')}>Edit</Button>
              {a.status === 'available' ? (
                <Button variant="primary" onClick={() => setDialog('lend')}>
                  <UserRoundPlus /> Lend
                </Button>
              ) : null}
              {a.status === 'assigned' ? (
                <>
                  <Button onClick={() => giveBack.mutate(true)}>Return for maintenance</Button>
                  <Button variant="primary" onClick={() => giveBack.mutate(false)}>
                    <Undo2 /> Return
                  </Button>
                </>
              ) : null}
              {a.status === 'available' ? (
                <Button variant="ghost" onClick={() => setStatus.mutate('maintenance')}>
                  Send for maintenance
                </Button>
              ) : null}
              {a.status === 'maintenance' ? (
                <Button variant="primary" onClick={() => setStatus.mutate('available')}>
                  Back in service
                </Button>
              ) : null}
              {a.status !== 'retired' && a.status !== 'assigned' ? (
                <Button
                  variant="ghost"
                  onClick={() => window.confirm(`Retire ${a.tag}?`) && setStatus.mutate('retired')}
                >
                  Retire
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="mx-auto grid max-w-5xl gap-4 p-4 md:p-6 lg:grid-cols-[1fr_320px]">
        <Pane title="History" padded={false}>
          <ol className="divide-y divide-line">
            {(a.history ?? []).map((h, i) => (
              <li key={i} className="px-4 py-2.5 text-sm">
                <span className="font-medium">{HISTORY[h.kind] ?? h.kind}</span>
                {h.contact ? (
                  <>
                    {' '}
                    <Link to={`/contacts/${h.contact.uuid}`} className="text-primary hover:underline">
                      {h.contact.name}
                    </Link>
                  </>
                ) : null}
                {h.note ? <span className="text-muted"> · {h.note}</span> : null}
                <span className="block text-xs text-muted">
                  {formatDateTime(h.at)}
                  {h.by ? ` · ${h.by.name}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </Pane>
        <Pane title="Details">
          <dl className="flex flex-col gap-2 text-sm">
            {(
              [
                ['Category', a.category],
                ['Serial', a.serial],
                ['Location', a.location],
                ['Purchased', a.purchasedOn ? formatDate(a.purchasedOn) : ''],
                ['With', a.assignedTo?.name ?? ''],
                ['Due back', a.dueBack ? formatDate(a.dueBack) : ''],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            {a.notes ? <p className="whitespace-pre-wrap text-muted">{a.notes}</p> : null}
          </dl>
        </Pane>
      </div>
      {dialog === 'edit' ? <AssetDialog asset={a} onDone={() => setDialog(null)} /> : null}
      {dialog === 'lend' ? <LendDialog asset={a} onDone={() => setDialog(null)} /> : null}
    </div>
  );
}

function OverviewWidget({ data }: { data: unknown }) {
  const d = data as {
    available: number;
    assigned: number;
    maintenance: number;
    overdue: number;
    lowStock: Stock[];
  };
  return (
    <div className="flex flex-1 flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            ['Available', d.available],
            ['Lent out', d.assigned],
            ['Overdue', d.overdue],
          ] as const
        ).map(([k, n]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd
              className={`text-2xl font-semibold tracking-tight tabular-nums ${k === 'Overdue' && n ? 'text-accent' : ''}`}
            >
              {n}
            </dd>
          </div>
        ))}
      </dl>
      {d.lowStock.length ? (
        <div>
          <p className="text-xs font-medium text-muted">Running low</p>
          <ul className="text-sm">
            {d.lowStock.map((s) => (
              <li key={s.uuid} className="flex justify-between">
                <span className="truncate">{s.name}</span>
                <span className="tabular-nums text-accent">
                  {s.quantity} {s.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Link to={ROOT} className="mt-auto text-sm text-primary hover:underline">
        Open inventory
      </Link>
    </div>
  );
}

const assetsModule: WebModule = {
  key: 'assets',
  routes: [
    { path: '', element: <InventoryHome /> },
    { path: ':uuid', element: <AssetPage /> },
  ],
  widgets: { 'assets.overview': (p) => <OverviewWidget data={p.data} /> },
};

export default assetsModule;
