import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreHorizontal, Plus, ShieldCheck, Users as UsersIcon } from 'lucide-react';
import { RECORD_ACTIONS, SCOPED_RESOURCES, SCOPES, hasPermission, type Scope } from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, Sheet } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { SettingsPage } from './layout';

interface RoleDto {
  uuid: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  scopes: Record<string, Scope>;
  userCount: number;
  sourceBlueprint: string | null;
  customized: boolean;
}
interface TeamDto {
  uuid: string;
  name: string;
  members: { uuid: string; firstName: string; lastName: string; email: string; isLead: boolean }[];
}
interface UserDto {
  uuid: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'invited' | 'active' | 'disabled';
  totpEnabled: boolean;
  lastLoginAt: string | null;
  roles: { key: string; name: string }[];
  teams: { uuid: string; name: string }[];
}
interface PermissionDef {
  key: string;
  description: string;
  moduleKey: string;
}

const useRoles = () =>
  useQuery({ queryKey: ['roles'], queryFn: () => apiGet<{ data: RoleDto[] }>('/roles').then((r) => r.data) });
const useTeams = () =>
  useQuery({ queryKey: ['teams'], queryFn: () => apiGet<{ data: TeamDto[] }>('/teams').then((r) => r.data) });

// ---------------- Users ----------------

export function UsersPage() {
  const t = useT();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const [transferring, setTransferring] = useState<UserDto | null>(null);
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () => apiGet<{ data: UserDto[] }>('/users', { q, pageSize: 100 }).then((r) => r.data),
  });
  const qc = useQueryClient();
  const action = useMutation({
    mutationFn: ({ uuid, op }: { uuid: string; op: 'disable' | 'enable' | 'resend-invite' | 'reset-2fa' }) =>
      apiPost(`/users/${uuid}/${op}`),
    onSuccess: (_, v) => {
      toast.success(
        {
          disable: 'User disabled',
          enable: 'User enabled',
          'resend-invite': 'Invitation sent',
          'reset-2fa': 'Two-factor reset',
        }[v.op],
      );
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <SettingsPage
      title={t('settings.users')}
      description="Invite people and choose what they can do."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> Invite user
        </Button>
      }
    >
      <Input
        placeholder="Search by name or email"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-xs"
        aria-label="Search users"
      />
      <Pane padded={false}>
        {users.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : !users.data?.length ? (
          <EmptyState
            icon={<UsersIcon />}
            title="No users match"
            description="Try a different search, or invite someone new."
          />
        ) : (
          <ul className="divide-y divide-line">
            {users.data.map((u) => {
              const name = `${u.firstName} ${u.lastName}`.trim() || u.email;
              return (
                <li key={u.uuid} className="flex items-center gap-3 px-4 py-2.5">
                  <Avatar name={name} />
                  <button type="button" onClick={() => setEditing(u)} className="min-w-0 flex-1 text-start">
                    <span className="block truncate text-sm font-medium hover:underline">{name}</span>
                    <span className="block truncate text-xs text-muted">{u.email}</span>
                  </button>
                  <div className="hidden flex-wrap justify-end gap-1 sm:flex">
                    {u.roles.map((r) => (
                      <Badge key={r.key} tone={r.key === 'admin' ? 'primary' : 'neutral'}>
                        {r.name}
                      </Badge>
                    ))}
                  </div>
                  {u.status !== 'active' ? (
                    <Badge tone={u.status === 'disabled' ? 'accent' : 'outline'}>
                      {u.status === 'invited' ? 'Invited' : 'Disabled'}
                    </Badge>
                  ) : null}
                  {u.totpEnabled ? (
                    <ShieldCheck className="size-4 text-primary" aria-label="Two-factor on" />
                  ) : null}
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
                        <MoreHorizontal />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem onSelect={() => setEditing(u)}>Edit</MenuItem>
                      {u.status === 'invited' ? (
                        <MenuItem onSelect={() => action.mutate({ uuid: u.uuid, op: 'resend-invite' })}>
                          Resend invitation
                        </MenuItem>
                      ) : null}
                      {u.totpEnabled ? (
                        <MenuItem onSelect={() => action.mutate({ uuid: u.uuid, op: 'reset-2fa' })}>
                          Reset two-factor
                        </MenuItem>
                      ) : null}
                      <MenuItem onSelect={() => setTransferring(u)}>Transfer records</MenuItem>
                      {u.status === 'disabled' ? (
                        <MenuItem onSelect={() => action.mutate({ uuid: u.uuid, op: 'enable' })}>
                          Enable
                        </MenuItem>
                      ) : (
                        <MenuItem danger onSelect={() => action.mutate({ uuid: u.uuid, op: 'disable' })}>
                          Disable
                        </MenuItem>
                      )}
                    </MenuContent>
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </Pane>
      {editing ? (
        <UserSheet user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      {transferring ? (
        <TransferDialog from={transferring} users={users.data ?? []} onClose={() => setTransferring(null)} />
      ) : null}
    </SettingsPage>
  );
}

/** Hand everything a user owns or is assigned to another active user (use before or after disabling them). */
export function TransferDialog({
  from,
  users,
  onClose,
}: {
  from: UserDto;
  users: UserDto[];
  onClose: () => void;
}) {
  const [toUuid, setToUuid] = useState('');
  const candidates = users.filter((u) => u.uuid !== from.uuid && u.status === 'active');
  const name = (u: UserDto) => `${u.firstName} ${u.lastName}`.trim() || u.email;
  const transfer = useMutation({
    mutationFn: () =>
      apiPost<{ moved: Record<string, number> }>(`/users/${from.uuid}/transfer-records`, { toUuid }),
    onSuccess: ({ moved }) => {
      const total = Object.values(moved).reduce((a, b) => a + b, 0);
      toast.success(`Transferred ${total} ${total === 1 ? 'record' : 'records'}`);
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not transfer records'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Transfer records from ${name(from)}`}
        description="Everything they own or are assigned to moves to the person you choose. This is recorded in the audit log."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => transfer.mutate()}
              loading={transfer.isPending}
              disabled={!toUuid}
            >
              Transfer
            </Button>
          </>
        }
      >
        <Field label="New owner" required>
          {(p) => (
            <NativeSelect {...p} value={toUuid} onChange={(e) => setToUuid(e.target.value)}>
              <option value="">Choose a user</option>
              {candidates.map((u) => (
                <option key={u.uuid} value={u.uuid}>
                  {name(u)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </DialogContent>
    </Dialog>
  );
}

function UserSheet({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const roles = useRoles();
  const teams = useTeams();
  const qc = useQueryClient();
  const [roleKeys, setRoleKeys] = useState<string[]>(user?.roles.map((r) => r.key) ?? []);
  const [teamUuids, setTeamUuids] = useState<string[]>(user?.teams.map((t) => t.uuid) ?? []);
  const form = useForm({
    defaultValues: {
      email: user?.email ?? '',
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: { email: string; firstName: string; lastName: string }) =>
      user
        ? apiPatch(`/users/${user.uuid}`, {
            firstName: v.firstName,
            lastName: v.lastName,
            roleKeys,
            teamUuids,
          })
        : apiPost('/users', { ...v, roleKeys, teamUuids, sendInvite: true }),
    onSuccess: () => {
      toast.success(user ? 'User updated' : 'Invitation sent');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError)
        for (const [k, m] of Object.entries(err.fieldErrors())) form.setError(k as 'email', { message: m });
    },
  });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={user ? 'Edit user' : 'Invite user'}
      description={user?.email}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={form.handleSubmit((v) => save.mutate(v))}
            loading={save.isPending}
            disabled={!roleKeys.length}
          >
            {user ? 'Save changes' : 'Send invitation'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 p-5">
        {!user ? (
          <Field label="Email" required error={form.formState.errors.email?.message}>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoFocus
                {...form.register('email', { required: 'Enter an email' })}
              />
            )}
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required>
            {(p) => <Input {...p} {...form.register('firstName', { required: true })} />}
          </Field>
          <Field label="Last name">{(p) => <Input {...p} {...form.register('lastName')} />}</Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-muted">Roles</legend>
          <div className="flex flex-col gap-2">
            {roles.data?.map((r) => (
              <label
                key={r.key}
                className="flex cursor-pointer items-start gap-3 rounded-sm border border-line p-2.5 hover:bg-hover"
              >
                <Checkbox
                  checked={roleKeys.includes(r.key)}
                  onCheckedChange={() => toggle(roleKeys, setRoleKeys, r.key)}
                  aria-label={r.name}
                />
                <span>
                  <span className="block text-sm font-medium">{r.name}</span>
                  {r.description ? <span className="block text-xs text-muted">{r.description}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {teams.data?.length ? (
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-muted">Teams</legend>
            <div className="flex flex-wrap gap-2">
              {teams.data.map((t) => (
                <label
                  key={t.uuid}
                  className="flex cursor-pointer items-center gap-2 rounded-sm border border-line px-2.5 py-1.5 text-sm hover:bg-hover"
                >
                  <Checkbox
                    checked={teamUuids.includes(t.uuid)}
                    onCheckedChange={() => toggle(teamUuids, setTeamUuids, t.uuid)}
                    aria-label={t.name}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>
    </Sheet>
  );
}

// ---------------- Teams ----------------

export function TeamsPage() {
  const t = useT();
  const teams = useTeams();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TeamDto | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/teams/${uuid}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['teams'] }),
  });
  return (
    <SettingsPage
      title={t('settings.teams')}
      description="Teams power the “team” record scope: people see records owned by anyone in their teams."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New team
        </Button>
      }
    >
      <Pane padded={false}>
        {teams.isPending ? (
          <Skeleton className="m-4 h-10" />
        ) : !teams.data?.length ? (
          <EmptyState
            icon={<UsersIcon />}
            title="No teams yet"
            description="Group people so managers can see their team's records."
            action={<Button onClick={() => setEditing('new')}>Create a team</Button>}
          />
        ) : (
          <ul className="divide-y divide-line">
            {teams.data.map((team) => (
              <li key={team.uuid} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{team.name}</p>
                  <p className="truncate text-xs text-muted">
                    {team.members.map((m) => `${m.firstName} ${m.lastName}`.trim()).join(', ') ||
                      'No members'}
                  </p>
                </div>
                <Button size="sm" onClick={() => setEditing(team)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(team.uuid)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <TeamDialog team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsPage>
  );
}

function TeamDialog({ team, onClose }: { team: TeamDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users', ''],
    queryFn: () => apiGet<{ data: UserDto[] }>('/users', { pageSize: 100 }).then((r) => r.data),
  });
  const [name, setName] = useState(team?.name ?? '');
  const [members, setMembers] = useState<string[]>(team?.members.map((m) => m.uuid) ?? []);
  const save = useMutation({
    mutationFn: () =>
      team
        ? apiPatch(`/teams/${team.uuid}`, { name, memberUuids: members })
        : apiPost('/teams', { name, memberUuids: members }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={team ? 'Edit team' : 'New team'}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-muted">Members</legend>
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {users.data?.map((u) => (
                <label
                  key={u.uuid}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-hover"
                >
                  <Checkbox
                    checked={members.includes(u.uuid)}
                    onCheckedChange={(v) =>
                      setMembers(v ? [...members, u.uuid] : members.filter((m) => m !== u.uuid))
                    }
                    aria-label={u.email}
                  />
                  {`${u.firstName} ${u.lastName}`.trim() || u.email}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Roles ----------------

export function RolesPage() {
  const t = useT();
  const roles = useRoles();
  const [editing, setEditing] = useState<RoleDto | 'new' | null>(null);
  return (
    <SettingsPage
      title={t('settings.roles')}
      description="Roles grant permissions, and decide whether people see their own records, their team's, or everyone's."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New role
        </Button>
      }
    >
      <Pane padded={false}>
        {roles.isPending ? (
          <Skeleton className="m-4 h-10" />
        ) : (
          <ul className="divide-y divide-line">
            {roles.data?.map((r) => (
              <li key={r.uuid}>
                <button
                  type="button"
                  onClick={() => setEditing(r)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {r.name}
                      {r.isSystem ? <Badge tone="primary">System</Badge> : null}
                      {r.sourceBlueprint && !r.customized ? (
                        <Badge tone="outline">From blueprint</Badge>
                      ) : null}
                    </p>
                    {r.description ? <p className="truncate text-xs text-muted">{r.description}</p> : null}
                  </div>
                  <span className="text-xs text-muted">
                    {r.userCount === 1 ? '1 user' : `${r.userCount} users`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <RoleEditor role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsPage>
  );
}

const RESOURCE_ENTITY: Record<string, string> = {
  'core.contacts': 'contactPlural',
  'core.organizations': 'organizationPlural',
  'core.leads': 'leadPlural',
  'core.deals': 'dealPlural',
  'core.activities': 'activityPlural',
};

function RoleEditor({ role, onClose }: { role: RoleDto | null; onClose: () => void }) {
  const boot = useBoot();
  const qc = useQueryClient();
  const catalog = useQuery({
    queryKey: ['permissions'],
    queryFn: () => apiGet<{ data: PermissionDef[] }>('/permissions').then((r) => r.data),
  });
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [scopes, setScopes] = useState<Record<string, Scope>>(role?.scopes ?? {});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !!role?.isSystem;

  const grouped = useMemo(() => {
    const groups = new Map<string, { resource: string; actions: Map<string, PermissionDef> }>();
    for (const p of catalog.data ?? []) {
      const [mod, res, action] = p.key.split('.') as [string, string, string];
      const resource = `${mod}.${res}`;
      if (!groups.has(resource)) groups.set(resource, { resource, actions: new Map() });
      groups.get(resource)!.actions.set(action, p);
    }
    return [...groups.values()];
  }, [catalog.data]);

  const recordGroups = grouped.filter(
    (g) =>
      [...g.actions.keys()].some((a) => (RECORD_ACTIONS as readonly string[]).includes(a)) &&
      g.actions.has('view'),
  );
  const otherGroups = grouped.filter((g) => !recordGroups.includes(g));

  const granted = (k: string) => hasPermission(perms, k);
  const toggle = (k: string) => {
    if (readOnly) return;
    if (perms.includes(k)) setPerms(perms.filter((p) => p !== k));
    else if (granted(k)) {
      // Covered by a wildcard: expand the wildcard minus this key.
      const wildcard = perms.find((p) => p.endsWith('.*') && k.startsWith(p.slice(0, -1)));
      if (!wildcard) return;
      const siblings = (catalog.data ?? [])
        .filter((c) => c.key.startsWith(wildcard.slice(0, -1)) && c.key !== k)
        .map((c) => c.key);
      setPerms([...perms.filter((p) => p !== wildcard), ...siblings]);
    } else setPerms([...perms, k]);
  };

  const save = useMutation({
    mutationFn: () =>
      role
        ? apiPatch(`/roles/${role.uuid}`, {
            name,
            description,
            ...(readOnly ? {} : { permissions: perms, scopes }),
          })
        : apiPost('/roles', { key, name, description, permissions: perms, scopes }),
    onSuccess: () => {
      toast.success('Role saved');
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/roles/${role!.uuid}`),
    onSuccess: () => {
      toast.success('Role deleted');
      void qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });

  const vocab = labelVars(boot.labels);
  const resourceLabel = (r: string) =>
    RESOURCE_ENTITY[r] ? vocab[RESOURCE_ENTITY[r]] : r.split('.').slice(1).join(' ').replace(/_/g, ' ');

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={role ? role.name : 'New role'}
      width="max-w-3xl"
      footer={
        <>
          {role && !role.isSystem ? (
            <Button variant="ghost" className="me-auto text-accent" onClick={() => setConfirmDelete(true)}>
              Delete role
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!name.trim() || (!role && !/^[a-z][a-z0-9_]{1,63}$/.test(key))}
          >
            Save role
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!role)
                    setKey(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '')
                        .slice(0, 63),
                    );
                }}
              />
            )}
          </Field>
          <Field label="Key" help="Used by blueprints and field visibility rules.">
            {(p) => (
              <Input
                {...p}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                disabled={!!role}
                className="font-mono text-xs"
              />
            )}
          </Field>
          <Field label="Description" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-14"
              />
            )}
          </Field>
        </div>
        {readOnly ? (
          <p className="rounded-sm bg-primary-soft px-3 py-2 text-sm">
            The Admin role always has full access to everything.
          </p>
        ) : null}
        {catalog.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Records</h3>
              <div className="overflow-x-auto rounded-sm border border-line">
                <table className="w-full text-table">
                  <thead>
                    <tr className="border-b border-line bg-subtle text-xs text-muted">
                      <th className="px-3 py-2 text-start font-medium">Resource</th>
                      {RECORD_ACTIONS.map((a) => (
                        <th key={a} className="px-1.5 py-2 text-center font-medium capitalize">
                          {a}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-start font-medium">Can see</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordGroups.map((g) => (
                      <tr key={g.resource} className="border-b border-line last:border-0">
                        <td className="px-3 py-2 font-medium capitalize">{resourceLabel(g.resource)}</td>
                        {RECORD_ACTIONS.map((a) => {
                          const p = g.actions.get(a);
                          return (
                            <td key={a} className="px-1.5 py-2 text-center">
                              {p ? (
                                <span className="inline-flex">
                                  <Checkbox
                                    checked={readOnly || granted(p.key)}
                                    onCheckedChange={() => toggle(p.key)}
                                    disabled={readOnly}
                                    aria-label={`${a} ${g.resource}`}
                                  />
                                </span>
                              ) : null}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2">
                          {(SCOPED_RESOURCES as readonly string[]).includes(g.resource) ? (
                            <NativeSelect
                              aria-label={`Scope for ${g.resource}`}
                              value={readOnly ? 'all' : (scopes[g.resource] ?? scopes['*'] ?? 'own')}
                              disabled={readOnly}
                              onChange={(e) =>
                                setScopes({ ...scopes, [g.resource]: e.target.value as Scope })
                              }
                              className="h-7 w-28 text-xs"
                            >
                              {SCOPES.map((s) => (
                                <option key={s} value={s}>
                                  {{ own: 'Own', team: 'Team', all: 'Everyone' }[s]}
                                </option>
                              ))}
                            </NativeSelect>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Other permissions</h3>
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {otherGroups.flatMap((g) =>
                  [...g.actions.values()].map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={readOnly || granted(p.key)}
                        onCheckedChange={() => toggle(p.key)}
                        disabled={readOnly}
                        aria-label={p.description}
                      />
                      <span>{p.description}</span>
                      {p.moduleKey !== 'core' ? <Badge tone="outline">{p.moduleKey}</Badge> : null}
                    </label>
                  )),
                )}
              </div>
            </section>
          </>
        )}
      </div>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title="Delete this role?"
          description="People must be moved to another role first."
          footer={
            <>
              <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
                Delete role
              </Button>
            </>
          }
        />
      </Dialog>
    </Sheet>
  );
}
