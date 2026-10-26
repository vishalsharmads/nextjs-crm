import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useBranding } from '@/app/branding';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { AuthLayout } from '@/features/auth/auth-layout';

/**
 * Public opt-out page linked from marketing email. Needs a click (not just a visit), because
 * mail scanners open links; mail clients use the one-click POST instead.
 */
export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { branding } = useBranding();
  const [doNotSell, setDoNotSell] = useState(false);
  useEffect(() => setDocumentTitle('Unsubscribe', branding.appName), [branding.appName]);
  const check = useQuery({
    queryKey: ['unsubscribe', token],
    queryFn: async () => {
      const res = await fetch(`/api/v1/public/privacy/unsubscribe?token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('invalid');
      return (await res.json()) as { valid: boolean; optedOut: boolean };
    },
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async () => {
      // Public endpoint: no session or CSRF token; the signed link authorizes it.
      const res = await fetch('/api/v1/public/privacy/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, doNotSell }),
      });
      if (!res.ok) throw new Error('failed');
    },
  });

  if (check.isPending) {
    return (
      <AuthLayout title="Unsubscribe">
        <Skeleton className="h-24" />
      </AuthLayout>
    );
  }
  if (check.isError || !check.data.valid) {
    return (
      <AuthLayout title="This link does not work">
        <p className="text-sm text-muted">
          The unsubscribe link is incomplete or no longer valid. Reply to the email you received and ask to be
          removed instead.
        </p>
      </AuthLayout>
    );
  }
  if (submit.isSuccess || check.data.optedOut) {
    return (
      <AuthLayout title="You are unsubscribed">
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-5 text-primary" aria-hidden="true" />
          You will not get marketing email from {branding.appName} any more.
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Unsubscribe" description={`Stop marketing email from ${branding.appName}.`}>
      <div className="flex flex-col gap-4">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={doNotSell}
            onChange={(e) => setDoNotSell(e.target.checked)}
          />
          Also, do not sell or share my personal information.
        </label>
        {submit.isError ? (
          <p role="alert" className="text-sm text-accent">
            That did not work. Try again in a moment.
          </p>
        ) : null}
        <Button variant="primary" size="lg" loading={submit.isPending} onClick={() => submit.mutate()}>
          Unsubscribe
        </Button>
      </div>
    </AuthLayout>
  );
}
