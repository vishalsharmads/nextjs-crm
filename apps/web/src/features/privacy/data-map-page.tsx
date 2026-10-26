import { useQuery } from '@tanstack/react-query';
import type { Sensitivity } from '@app/shared';
import { apiGet } from '@/lib/api';
import { useBoot, useT } from '@/app/session';
import { Badge, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { useEntityConfig } from '@/features/records/entities';
import { SettingsPage } from '@/features/settings/layout';

interface DataMap {
  profile: string;
  records: {
    entity: 'contact' | 'organization' | 'lead' | 'deal' | 'activity';
    rows: number;
    coreFields: string[];
    customFields: { key: string; label: string; sensitivity: Sensitivity }[];
  }[];
  modules: { key: string; tables: string[] }[];
  system: { area: string; data: string; retention: string }[];
  recipients: { name: string; detail: string }[];
  retentionRules: number;
}

const SENSITIVITY: Record<Sensitivity, string> = {
  normal: 'Not personal',
  personal: 'Personal',
  special: 'Sensitive',
};

function RecordSection({ r }: { r: DataMap['records'][number] }) {
  const config = useEntityConfig(r.entity);
  const custom = r.customFields.filter((f) => f.sensitivity !== 'normal');
  return (
    <Pane title={`${config.plural} (${r.rows})`}>
      <div className="flex flex-col gap-2 text-sm">
        <p>
          <span className="text-muted">Built-in: </span>
          {r.coreFields.join(', ')}
        </p>
        {custom.length ? (
          <ul className="flex flex-wrap gap-2">
            {custom.map((f) => (
              <li key={f.key}>
                <Badge tone={f.sensitivity === 'special' ? 'accent' : 'outline'}>
                  {f.label} · {SENSITIVITY[f.sensitivity]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {r.customFields.length > custom.length ? (
          <p className="text-xs text-muted">
            {r.customFields.length - custom.length} other custom field(s) are not marked as personal data.
            Check them under Fields.
          </p>
        ) : null}
      </div>
    </Pane>
  );
}

/** What personal data the workspace holds, where, for how long, and who receives it. */
export function DataMapPage() {
  const t = useT();
  const { modules } = useBoot();
  const q = useQuery({
    queryKey: ['privacy', 'data-map'],
    queryFn: () => apiGet<DataMap>('/privacy/data-map'),
  });
  return (
    <SettingsPage
      title={t('settings.dataMap')}
      description="What personal data this workspace holds, where, for how long, and who receives it. Use it as the starting point for your record of processing activities."
    >
      {q.isPending ? (
        <Skeleton className="h-96" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {q.data.records.map((r) => (
            <RecordSection key={r.entity} r={r} />
          ))}
          {q.data.modules.length ? (
            <Pane title="Modules">
              <ul className="flex flex-col gap-1 text-sm">
                {q.data.modules.map((m) => (
                  <li key={m.key}>
                    <span className="font-medium">
                      {modules.menu.find((x) => x.moduleKey === m.key)?.label ?? m.key}
                    </span>
                    {modules.enabled.includes(m.key) ? null : (
                      <span className="text-muted"> (turned off)</span>
                    )}
                  </li>
                ))}
              </ul>
            </Pane>
          ) : null}
          <Pane title="System records" padded={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th className="px-4 py-2 text-start font-medium">Where</th>
                  <th className="px-4 py-2 text-start font-medium">Personal data</th>
                  <th className="px-4 py-2 text-start font-medium">Kept</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {q.data.system.map((s) => (
                  <tr key={s.area}>
                    <td className="px-4 py-2 font-medium">{s.area}</td>
                    <td className="px-4 py-2">{s.data}</td>
                    <td className="px-4 py-2 text-muted">{s.retention}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Pane>
          <Pane title="Who receives data">
            <ul className="flex flex-col gap-1 text-sm">
              {q.data.recipients.map((r) => (
                <li key={r.name}>
                  <span className="font-medium">{r.name}</span> <span className="text-muted">{r.detail}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">
              Also list your hosting provider and backup storage. Each needs a data processing agreement (and
              a business associate agreement for health data).
            </p>
          </Pane>
        </>
      )}
    </SettingsPage>
  );
}
