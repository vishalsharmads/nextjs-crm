import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { useBranding } from '@/app/branding';
import { bootstrapKey, useSession, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { AuthLayout } from './auth-layout';

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p
      role="alert"
      className="mb-4 rounded-sm border border-accent bg-accent-soft px-3 py-2 text-sm text-accent"
    >
      {error}
    </p>
  ) : null;
}

export function LoginPage() {
  const t = useT();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const session = useSession();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(
      z.object({ email: z.email('Enter a valid email'), password: z.string().min(1, 'Enter your password') }),
    ),
  });
  const mfa = useForm({
    resolver: zodResolver(z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })),
  });

  useEffect(() => setDocumentTitle(t('auth.signIn'), branding.appName), [t, branding.appName]);
  useEffect(() => {
    if (session.status === 'authenticated') navigate(params.get('next') || '/', { replace: true });
  }, [session.status, navigate, params]);

  const done = async () => {
    await qc.invalidateQueries({ queryKey: bootstrapKey });
  };

  const onPassword = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<{ mfaRequired: boolean }>('/auth/login', {
        method: 'POST',
        body: values,
        noRetry: true,
      });
      if (res.mfaRequired) setStep('mfa');
      else await done();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed');
    }
  });

  const onCode = mfa.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/2fa/verify', { method: 'POST', body: values, noRetry: true });
      await done();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    }
  });

  if (!branding.installed) {
    return (
      <AuthLayout title={branding.appName}>
        <p className="text-sm text-muted">{t('auth.notInstalled')}</p>
      </AuthLayout>
    );
  }

  if (step === 'mfa') {
    return (
      <AuthLayout title={t('auth.mfaTitle')} description={t('auth.mfaHelp')}>
        <FormError error={error} />
        <form onSubmit={onCode} className="flex flex-col gap-4" noValidate>
          <Field label={t('auth.code')} error={mfa.formState.errors.code?.message}>
            {(p) => (
              <Input
                {...p}
                {...mfa.register('code')}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                className="h-10 text-center text-lg tracking-[0.4em]"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={mfa.formState.isSubmitting}>
            {t('auth.verify')}
          </Button>
          <Button type="button" variant="link" onClick={() => setStep('password')}>
            {t('auth.backToSignIn')}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t('auth.signInTo', { app: branding.appName })}
      description={branding.tagline || undefined}
    >
      <FormError error={error} />
      <form onSubmit={onPassword} className="flex flex-col gap-4" noValidate>
        <Field label={t('auth.email')} error={form.formState.errors.email?.message}>
          {(p) => (
            <Input
              {...p}
              {...form.register('email')}
              type="email"
              autoComplete="username"
              autoFocus
              className="h-10"
            />
          )}
        </Field>
        <Field label={t('auth.password')} error={form.formState.errors.password?.message}>
          {(p) => (
            <Input
              {...p}
              {...form.register('password')}
              type="password"
              autoComplete="current-password"
              className="h-10"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
          {t('auth.signIn')}
        </Button>
        <Link to="/forgot-password" className="text-center text-sm text-primary hover:underline">
          {t('auth.forgot')}
        </Link>
      </form>
      {branding.demoLogin ? (
        <DemoLogin
          email={branding.demoLogin.email}
          password={branding.demoLogin.password}
          onUse={() => {
            form.setValue('email', branding.demoLogin!.email);
            form.setValue('password', branding.demoLogin!.password);
            void onPassword();
          }}
        />
      ) : null}
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const form = useForm({ resolver: zodResolver(z.object({ email: z.email('Enter a valid email') })) });
  const onSubmit = form.handleSubmit(async (values) => {
    await api('/auth/password/forgot', { method: 'POST', body: values, noRetry: true }).catch(
      () => undefined,
    );
    setSent(true);
  });
  return (
    <AuthLayout title={t('auth.forgotTitle')} description={sent ? undefined : t('auth.forgotHelp')}>
      {sent ? (
        <p className="rounded-sm bg-primary-soft px-3 py-2 text-sm">{t('auth.linkSent')}</p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <Field label={t('auth.email')} error={form.formState.errors.email?.message}>
            {(p) => (
              <Input
                {...p}
                {...form.register('email')}
                type="email"
                autoComplete="email"
                autoFocus
                className="h-10"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
            {t('auth.sendLink')}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-6 block text-center text-sm text-primary hover:underline">
        {t('auth.backToSignIn')}
      </Link>
    </AuthLayout>
  );
}

function SetPasswordForm({
  endpoint,
  title,
  description,
}: {
  endpoint: string;
  title: string;
  description?: string;
}) {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const token = params.get('token') ?? '';
  const form = useForm({
    resolver: zodResolver(
      z
        .object({ password: z.string().min(1, 'Choose a password'), confirm: z.string() })
        .refine((v) => v.password === v.confirm, { message: t('auth.passwordsMismatch'), path: ['confirm'] }),
    ),
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api(endpoint, { method: 'POST', body: { token, password: values.password }, noRetry: true });
      toast.success(t('auth.passwordUpdated'));
      navigate('/login');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors().password)
        form.setError('password', { message: err.fieldErrors().password });
      else setError(err instanceof Error ? err.message : 'Could not set the password');
    }
  });
  return (
    <AuthLayout title={title} description={description}>
      <FormError error={error} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('auth.newPassword')}
          error={form.formState.errors.password?.message}
          help="At least 12 characters with upper and lowercase letters and a digit."
        >
          {(p) => (
            <Input
              {...p}
              {...form.register('password')}
              type="password"
              autoComplete="new-password"
              autoFocus
              className="h-10"
            />
          )}
        </Field>
        <Field label={t('auth.confirmPassword')} error={form.formState.errors.confirm?.message}>
          {(p) => (
            <Input
              {...p}
              {...form.register('confirm')}
              type="password"
              autoComplete="new-password"
              className="h-10"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
          {t('auth.setPassword')}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const t = useT();
  return <SetPasswordForm endpoint="/auth/password/reset" title={t('auth.forgotTitle')} />;
}

export function AcceptInvitePage() {
  const t = useT();
  return (
    <SetPasswordForm
      endpoint="/auth/invite/accept"
      title={t('auth.inviteTitle')}
      description={t('auth.inviteHelp')}
    />
  );
}

/** Shown only on demo instances (enabled with `npm run cli -w @app/api -- demo:enable`). */
function DemoLogin({ email, password, onUse }: { email: string; password: string; onUse: () => void }) {
  const t = useT();
  return (
    <section
      aria-labelledby="demo-login"
      className="mt-8 rounded-md border border-dashed border-line-strong bg-subtle p-4"
    >
      <h2 id="demo-login" className="text-sm font-semibold">
        {t('auth.demoTitle')}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">{t('auth.email')}</dt>
        <dd className="font-mono text-xs leading-5 break-all select-all">{email}</dd>
        <dt className="text-muted">{t('auth.password')}</dt>
        <dd className="font-mono text-xs leading-5 select-all">{password}</dd>
      </dl>
      <Button type="button" className="mt-3 w-full" onClick={onUse}>
        {t('auth.demoUse')}
      </Button>
    </section>
  );
}
