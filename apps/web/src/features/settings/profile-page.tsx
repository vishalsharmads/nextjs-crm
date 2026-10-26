import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { Monitor, ShieldCheck } from 'lucide-react';
import type { SessionDto } from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Badge, Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SettingsPage } from './layout';

export function ProfilePage() {
  const t = useT();
  return (
    <SettingsPage title={t('settings.profile')}>
      <ProfileForm />
      <PasswordForm />
      <TwoFactor />
      <Sessions />
    </SettingsPage>
  );
}

function ProfileForm() {
  const { me } = useBoot();
  const qc = useQueryClient();
  const t = useT();
  const form = useForm({ defaultValues: { firstName: me.firstName, lastName: me.lastName } });
  const save = useMutation({
    mutationFn: (v: { firstName: string; lastName: string }) => apiPatch('/me', v),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  return (
    <Pane title="Name">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">{(p) => <Input {...p} {...form.register('firstName')} />}</Field>
        <Field label="Last name">{(p) => <Input {...p} {...form.register('lastName')} />}</Field>
        <p className="text-sm text-muted sm:col-span-2">
          Signed in as <span className="text-ink">{me.email}</span>
        </p>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('common.saveChanges')}
          </Button>
        </div>
      </form>
    </Pane>
  );
}

function PasswordForm() {
  const form = useForm({ defaultValues: { currentPassword: '', newPassword: '' } });
  const save = useMutation({
    mutationFn: (v: { currentPassword: string; newPassword: string }) => apiPost('/me/password', v),
    onSuccess: () => {
      toast.success('Password changed. Other sessions were signed out.');
      form.reset();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        const fe = err.fieldErrors();
        if (fe.currentPassword) form.setError('currentPassword', { message: fe.currentPassword });
        if (fe.password) form.setError('newPassword', { message: fe.password });
      }
    },
  });
  return (
    <Pane title="Password">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
        <Field label="Current password" error={form.formState.errors.currentPassword?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              {...form.register('currentPassword', { required: true })}
            />
          )}
        </Field>
        <Field label="New password" error={form.formState.errors.newPassword?.message}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              {...form.register('newPassword', { required: true })}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" loading={save.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Pane>
  );
}

function TwoFactor() {
  const { me } = useBoot();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (setup) void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 184 }).then(setQr);
  }, [setup]);

  const start = useMutation({
    mutationFn: () => apiPost<{ secret: string; otpauthUrl: string }>('/me/2fa/setup'),
    onSuccess: setSetup,
  });
  const enable = useMutation({
    mutationFn: () => apiPost<{ recoveryCodes: string[] }>('/me/2fa/enable', { code }),
    onSuccess: (res) => {
      toast.success('Two-factor authentication is on');
      setSetup(null);
      setCode('');
      setCodes(res.recoveryCodes);
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => apiPost<{ recoveryCodes: string[] }>('/me/2fa/recovery-codes', { password }),
    onSuccess: (res) => {
      toast.success('Recovery codes replaced');
      setRegenOpen(false);
      setPassword('');
      setCodes(res.recoveryCodes);
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  const disable = useMutation({
    mutationFn: () => apiPost('/me/2fa/disable', { password }),
    onSuccess: () => {
      toast.success('Two-factor authentication is off');
      setDisableOpen(false);
      setPassword('');
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });

  return (
    <Pane
      title="Two-factor authentication"
      actions={
        me.totpEnabled ? (
          <Badge tone="primary">
            <ShieldCheck className="size-3" /> On
          </Badge>
        ) : (
          <Badge>Off</Badge>
        )
      }
    >
      {me.totpEnabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted">
            <p>You'll be asked for a code from your authenticator app when you sign in.</p>
            <p className={me.recoveryCodesLeft <= 2 ? 'text-accent' : undefined}>
              {me.recoveryCodesLeft === 1
                ? '1 recovery code left.'
                : `${me.recoveryCodesLeft} recovery codes left.`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setRegenOpen(true)}>
              Replace recovery codes
            </Button>
            <Button variant="secondary" onClick={() => setDisableOpen(true)}>
              Turn off
            </Button>
          </div>
        </div>
      ) : setup ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="shrink-0 rounded-md border border-line bg-surface p-2">
            {qr ? (
              <img src={qr} alt="QR code for your authenticator app" className="size-[184px]" />
            ) : (
              <Skeleton className="size-[184px]" />
            )}
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Scan the code with an authenticator app, then enter the 6-digit code it shows.
            </p>
            <p className="text-xs text-muted">
              Can't scan? Enter this key: <code className="break-all text-ink">{setup.secret}</code>
            </p>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                aria-label="Code"
                className="w-32 tracking-widest"
              />
              <Button
                variant="primary"
                onClick={() => enable.mutate()}
                loading={enable.isPending}
                disabled={code.length !== 6}
              >
                Turn on
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Add a second step at sign-in using an authenticator app.</p>
          <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending}>
            Set up
          </Button>
        </div>
      )}
      <Dialog open={codes !== null} onOpenChange={(open) => !open && setCodes(null)}>
        <DialogContent
          title="Save your recovery codes"
          description="Use one of these if you lose your authenticator app. Each code works once, and you won't see them again."
          footer={
            <>
              <Button onClick={() => void navigator.clipboard?.writeText(codes?.join('\n') ?? '')}>
                Copy
              </Button>
              <Button variant="primary" onClick={() => setCodes(null)}>
                I saved them
              </Button>
            </>
          }
        >
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
            {codes?.map((c) => (
              <li key={c} className="rounded-sm border border-line bg-canvas px-2 py-1 text-center">
                {c}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent
          title="Replace recovery codes"
          description="Your current codes stop working. Confirm with your password."
          footer={
            <>
              <Button onClick={() => setRegenOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => regenerate.mutate()} loading={regenerate.isPending}>
                Replace
              </Button>
            </>
          }
        >
          <Field label="Password">
            {(p) => (
              <Input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
        </DialogContent>
      </Dialog>
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent
          title="Turn off two-factor authentication"
          description="Confirm with your password."
          footer={
            <>
              <Button onClick={() => setDisableOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => disable.mutate()} loading={disable.isPending}>
                Turn off
              </Button>
            </>
          }
        >
          <Field label="Password">
            {(p) => (
              <Input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
        </DialogContent>
      </Dialog>
    </Pane>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'sessions'], queryFn: () => apiGet<SessionDto[]>('/me/sessions') });
  const revoke = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/me/sessions/${uuid}`),
    onSuccess: () => {
      toast.success('Session signed out');
      void qc.invalidateQueries({ queryKey: ['me', 'sessions'] });
    },
  });
  return (
    <Pane title="Active sessions" padded={false}>
      {q.isPending ? (
        <div className="p-4">
          <Skeleton className="h-10" />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {q.data?.map((s) => (
            <li key={s.uuid} className="flex items-center gap-3 px-4 py-3">
              <Monitor className="size-4 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{describeAgent(s.userAgent)}</p>
                <p className="text-xs text-muted">
                  {s.ip ?? 'Unknown IP'} · last active {new Date(s.lastUsedAt).toLocaleString()}
                </p>
              </div>
              {s.current ? (
                <Badge tone="primary">This device</Badge>
              ) : (
                <Button size="sm" onClick={() => revoke.mutate(s.uuid)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' on ');
}
