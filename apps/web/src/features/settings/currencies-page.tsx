import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import type { ExchangeRatesDto } from '@app/shared';
import { ApiError, apiGet, apiPut } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { SettingsPage } from './layout';

/** Settings → Currencies: exchange rates that reports use to convert into the workspace currency. */
export function CurrenciesPage() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['exchange-rates'],
    queryFn: () => apiGet<ExchangeRatesDto>('/exchange-rates'),
  });
  const [rows, setRows] = useState<{ currency: string; rate: string }[]>([]);
  useEffect(() => {
    if (q.data)
      setRows(Object.entries(q.data.rates).map(([currency, rate]) => ({ currency, rate: String(rate) })));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      apiPut('/exchange-rates', {
        rates: Object.fromEntries(
          rows
            .filter((r) => r.currency.length === 3 && Number(r.rate) > 0)
            .map((r) => [r.currency, Number(r.rate)]),
        ),
      }),
    onSuccess: () => {
      toast.success('Saved');
      void qc.invalidateQueries({ queryKey: ['exchange-rates'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the rates'),
  });
  const set = (i: number, patch: Partial<{ currency: string; rate: string }>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <SettingsPage
      title={t('settings.currencies')}
      description="Exchange rates used when reports convert every currency into the workspace currency. Records keep their own currency."
      actions={
        <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!q.data}>
          Save
        </Button>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-32" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Pane>
          <div className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                1
                <Input
                  aria-label="Currency"
                  value={r.currency}
                  maxLength={3}
                  onChange={(e) => set(i, { currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
                  className="w-20 uppercase"
                />
                =
                <Input
                  aria-label={`Rate for ${r.currency || 'currency'}`}
                  type="number"
                  min={0}
                  step="any"
                  value={r.rate}
                  onChange={(e) => set(i, { rate: e.target.value })}
                  className="w-36"
                />
                {q.data.base}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${r.currency}`}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => setRows([...rows, { currency: '', rate: '' }])}>
                <Plus /> Add a currency
              </Button>
            </div>
            {q.data.updatedAt ? (
              <p className="text-xs text-faint">Last changed {formatDateTime(q.data.updatedAt)}</p>
            ) : null}
          </div>
        </Pane>
      )}
    </SettingsPage>
  );
}
