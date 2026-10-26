import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, GitMerge, Mail, MoreHorizontal, Pencil, Trash2, UserCheck } from 'lucide-react';
import { ComposeEmail } from '@/features/email/compose-email';
import type { ContactDto, CoreEntity, DealDto, DuplicateCandidate, LeadDto, RelatedType } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useCan, useBoot } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { useHotkeys } from '@/app/shell/hotkeys';
import { Button } from '@/components/ui/button';
import {
  Badge,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Checkbox, Switch } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ActivityComposer, RecordActivities } from '@/features/activities/activity-components';
import { useRecord, useRecordMutations } from './api';
import { useEntityConfig, type EntityConfig } from './entities';
import { FieldsPanel } from './fields-panel';
import { RecordFormSheet } from './record-form';
import { Timeline } from './timeline';
import { FilesPanel } from './files-panel';
import { ConsentPanel } from '@/features/privacy/consent-panel';

type Rec = Record<string, unknown> & {
  uuid: string;
  custom: Record<string, unknown>;
  deletedAt: string | null;
};

export function RecordPage({ entity }: { entity: CoreEntity }) {
  const { uuid = '' } = useParams();
  const config = useEntityConfig(entity);
  const q = useRecord<Rec>(config.route, uuid);
  const { branding } = useBranding();
  const can = useCan();
  const navigate = useNavigate();
  const { remove, restore } = useRecordMutations<Rec>(config.route);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [converting, setConverting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const title = q.data ? config.title(q.data as never) : '';
  useEffect(
    () => setDocumentTitle(title || config.singular, branding.appName),
    [title, config.singular, branding.appName],
  );
  useHotkeys({ e: () => can(`${config.resource}.update`) && setEditing(true) });

  if (q.isPending) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rec = q.data;
  const related = entity as RelatedType;

  const doDelete = () =>
    remove.mutate(rec.uuid, {
      onSuccess: () => {
        toast.success(`${config.singular} deleted`, {
          action: { label: 'Undo', onClick: () => restore.mutate(rec.uuid) },
        });
        navigate(`/${config.route}`);
      },
    });

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line bg-surface px-4 py-4 md:px-6">
        <Link
          to={`/${config.route}`}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink"
        >
          <ArrowLeft className="size-3 rtl:-scale-x-100" /> {config.plural}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            <RecordSubheader entity={entity} rec={rec} config={config} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entity === 'lead' && !(rec as unknown as LeadDto).convertedAt && can('core.leads.update') ? (
              <Button variant="primary" onClick={() => setConverting(true)}>
                <UserCheck /> Convert
              </Button>
            ) : null}
            {typeof rec.email === 'string' && rec.email && can('core.email.use') ? (
              <Button onClick={() => setEmailing(true)}>
                <Mail /> Email
              </Button>
            ) : null}
            {can(`${config.resource}.update`) ? (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                {(entity === 'contact' || entity === 'organization') && can(`${config.resource}.merge`) ? (
                  <MenuItem onSelect={() => setMerging(true)}>
                    <GitMerge /> Find and merge duplicates
                  </MenuItem>
                ) : null}
                {can(`${config.resource}.delete`) ? (
                  <>
                    <MenuSeparator />
                    <MenuItem danger onSelect={doDelete}>
                      <Trash2 /> Delete
                    </MenuItem>
                  </>
                ) : null}
              </MenuContent>
            </Menu>
          </div>
        </div>
      </header>
      <div className="grid flex-1 gap-0 lg:grid-cols-[minmax(320px,400px)_1fr]">
        <aside className="border-b border-line bg-surface p-4 md:p-6 lg:border-e lg:border-b-0">
          <FieldsPanel config={config} record={rec} />
        </aside>
        <main className="min-w-0 p-4 md:p-6">
          {entity !== 'activity' ? (
            <div className="mb-5">
              <ActivityComposer related={{ type: related, uuid: rec.uuid }} />
            </div>
          ) : null}
          <Tabs defaultValue="timeline">
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="activities">Activities</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              {entity === 'contact' || entity === 'organization' ? (
                <TabsTrigger value="related">Related</TabsTrigger>
              ) : null}
              {entity === 'contact' || entity === 'lead' ? (
                <TabsTrigger value="privacy">Privacy</TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="timeline" className="pt-3">
              <Timeline config={config} uuid={rec.uuid} />
            </TabsContent>
            <TabsContent value="activities" className="pt-3">
              <RecordActivities type={related} uuid={rec.uuid} />
            </TabsContent>
            <TabsContent value="files" className="pt-3">
              <FilesPanel entity={related} uuid={rec.uuid} />
            </TabsContent>
            <TabsContent value="related" className="pt-3">
              <RelatedRecords entity={entity} rec={rec} />
            </TabsContent>
            {entity === 'contact' || entity === 'lead' ? (
              <TabsContent value="privacy" className="pt-3">
                <ConsentPanel entity={entity} uuid={rec.uuid} resource={config.resource} />
              </TabsContent>
            ) : null}
          </Tabs>
        </main>
      </div>
      <RecordFormSheet config={config} record={rec} open={editing} onOpenChange={setEditing} />
      {merging ? <MergeDialog config={config} rec={rec} onClose={() => setMerging(false)} /> : null}
      {emailing ? (
        <ComposeEmail
          to={rec.email as string}
          related={{ type: entity as RelatedType, uuid: rec.uuid }}
          onClose={() => setEmailing(false)}
        />
      ) : null}
      {converting ? (
        <ConvertLeadDialog lead={rec as unknown as LeadDto} onClose={() => setConverting(false)} />
      ) : null}
    </div>
  );
}

function RecordSubheader({ entity, rec, config }: { entity: CoreEntity; rec: Rec; config: EntityConfig }) {
  if (entity === 'deal') {
    const d = rec as unknown as DealDto;
    return (
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
        <span className="tabular text-ink">{formatMoney(d.value, d.currency)}</span>
        <Badge tone={d.stage.isWon ? 'primary' : d.stage.isLost ? 'accent' : 'neutral'}>{d.stage.name}</Badge>
        {d.reference ? <span>#{d.reference}</span> : null}
        {d.rotting ? <Badge tone="accent">Stalled</Badge> : null}
      </p>
    );
  }
  if (entity === 'lead') {
    const l = rec as unknown as LeadDto;
    return l.converted ? (
      <p className="mt-1 text-sm text-muted">
        Converted.{' '}
        {l.converted.contactUuid ? (
          <Link className="text-primary hover:underline" to={`/contacts/${l.converted.contactUuid}`}>
            Open the new record
          </Link>
        ) : null}
      </p>
    ) : (
      <p className="mt-1 text-sm text-muted">{config.subtitle?.(rec as never)}</p>
    );
  }
  const sub = config.subtitle?.(rec as never);
  return sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null;
}

function RelatedRecords({ entity, rec }: { entity: CoreEntity; rec: Rec }) {
  const dealConfig = useEntityConfig<DealDto>('deal');
  const filterField = entity === 'contact' ? 'contact' : 'organization';
  const deals = useQuery({
    queryKey: ['records', 'deals', 'list', 'related', entity, rec.uuid],
    queryFn: () =>
      apiGet<{ data: DealDto[] }>('/deals', {
        filter: JSON.stringify({ field: filterField, op: 'eq', value: rec.uuid }),
        pageSize: 50,
      }).then((r) => r.data),
  });
  const contacts = useQuery({
    queryKey: ['records', 'organizations', 'contacts', rec.uuid],
    queryFn: () => apiGet<{ data: ContactDto[] }>(`/organizations/${rec.uuid}/contacts`).then((r) => r.data),
    enabled: entity === 'organization',
  });
  const contactsLabel = useEntityConfig('contact').plural;
  return (
    <div className="flex flex-col gap-6">
      {entity === 'organization' ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{contactsLabel}</h3>
          {contacts.data?.length ? (
            <ul className="divide-y divide-line rounded-md border border-line bg-surface">
              {contacts.data.map((c) => (
                <li key={c.uuid} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <Link to={`/contacts/${c.uuid}`} className="font-medium hover:underline">
                    {c.fullName}
                  </Link>
                  <span className="truncate text-muted">
                    {c.organizations.find((o) => o.organization.uuid === rec.uuid)?.jobTitle ?? c.email}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None yet.</p>
          )}
        </section>
      ) : null}
      <section>
        <h3 className="mb-2 text-sm font-semibold">{dealConfig.plural}</h3>
        {deals.data?.length ? (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {deals.data.map((d) => (
              <li key={d.uuid} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <Link to={`/deals/${d.uuid}`} className="font-medium hover:underline">
                  {d.title}
                </Link>
                <span className="flex items-center gap-2">
                  <Badge tone={d.stage.isWon ? 'primary' : d.stage.isLost ? 'accent' : 'neutral'}>
                    {d.stage.name}
                  </Badge>
                  <span className="tabular">{formatMoney(d.value, d.currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">None yet.</p>
        )}
      </section>
    </div>
  );
}

function MergeDialog({ config, rec, onClose }: { config: EntityConfig; rec: Rec; onClose: () => void }) {
  const dealsLabel = useEntityConfig('deal').plural;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dupes = useQuery({
    queryKey: ['duplicates', config.route, rec.uuid],
    queryFn: () =>
      apiGet<{ data: DuplicateCandidate[] }>(`/${config.route}/${rec.uuid}/duplicates`).then((r) => r.data),
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const merge = useMutation({
    mutationFn: () =>
      apiPost<{ uuid: string }>(`/${config.route}/merge`, { primaryUuid: rec.uuid, secondaryUuids: chosen }),
    onSuccess: () => {
      toast.success(`Merged ${chosen.length} into ${config.title(rec as never)}`);
      void qc.invalidateQueries({ queryKey: ['records'] });
      onClose();
      navigate(`/${config.route}/${rec.uuid}`);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Merge duplicates"
        description={`Selected records merge into ${config.title(rec as never)}. Its values win; empty fields are filled from the others. Activities, files, ${dealsLabel.toLowerCase()} and tags move over.`}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!chosen.length}
              loading={merge.isPending}
              onClick={() => merge.mutate()}
            >
              Merge {chosen.length || ''}
            </Button>
          </>
        }
      >
        {dupes.isPending ? (
          <Skeleton className="h-20" />
        ) : !dupes.data?.length ? (
          <EmptyState
            title="No likely duplicates"
            description="Nothing shares an email, phone or name with this record."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {dupes.data.map((d) => (
              <li key={d.uuid}>
                <label className="flex cursor-pointer items-start gap-3 rounded-sm border border-line p-2.5 hover:bg-hover">
                  <Checkbox
                    checked={chosen.includes(d.uuid)}
                    onCheckedChange={(v) =>
                      setChosen(v ? [...chosen, d.uuid] : chosen.filter((x) => x !== d.uuid))
                    }
                    aria-label={d.title}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{d.title}</span>
                    <span className="block text-xs text-muted">
                      {d.subtitle} · {d.reasons.join(', ')}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConvertLeadDialog({ lead, onClose }: { lead: LeadDto; onClose: () => void }) {
  const boot = useBoot();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deal = useEntityConfig('deal');
  const org = useEntityConfig('organization');
  const [createOrganization, setCreateOrganization] = useState(!!lead.companyName);
  const [createDeal, setCreateDeal] = useState(true);
  const [dealTitle, setDealTitle] = useState(lead.companyName || lead.fullName);
  const [dealValue, setDealValue] = useState('');
  const pipelines = useMemo(() => boot.pipelines.filter((p) => p.entity === 'deal'), [boot.pipelines]);
  const convert = useMutation({
    mutationFn: () =>
      apiPost<{ contactUuid: string; dealUuid: string | null }>(`/leads/${lead.uuid}/convert`, {
        createOrganization,
        createDeal,
        dealTitle,
        dealValue: dealValue ? Number(dealValue) : undefined,
        pipelineUuid: pipelines.find((p) => p.isDefault)?.uuid,
      }),
    onSuccess: (r) => {
      toast.success('Converted');
      void qc.invalidateQueries({ queryKey: ['records'] });
      onClose();
      navigate(r.dealUuid ? `/deals/${r.dealUuid}` : `/contacts/${r.contactUuid}`);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Convert ${lead.fullName}`}
        description="Notes, tasks and calls logged so far move to the new record."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>
              Convert
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          {lead.companyName ? (
            <label className="flex items-center justify-between gap-3">
              Create {org.singular.toLowerCase()} “{lead.companyName}”
              <Switch checked={createOrganization} onCheckedChange={setCreateOrganization} />
            </label>
          ) : null}
          <label className="flex items-center justify-between gap-3">
            Create {deal.singular.toLowerCase()}
            <Switch checked={createDeal} onCheckedChange={setCreateDeal} />
          </label>
          {createDeal ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                value={dealTitle}
                onChange={(e) => setDealTitle(e.target.value)}
                aria-label="Title"
                placeholder="Title"
              />
              <Input
                type="number"
                min={0}
                value={dealValue}
                onChange={(e) => setDealValue(e.target.value)}
                aria-label="Value"
                placeholder={`Value (${boot.settings.general.currency})`}
              />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
