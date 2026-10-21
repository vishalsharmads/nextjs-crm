import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { ApiError, apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranding } from '@/app/branding';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { ErrorState, Skeleton } from '@/components/ui/misc';

interface PublicForm {
  uuid: string;
  appName: string;
  title: string;
  intro: string;
  submitLabel: string;
  consentText: string;
  fields: {
    name: string;
    label: string;
    required: boolean;
    placeholder: string;
    help: string;
    type: string;
    options: { value: string; label: string }[];
  }[];
}

/** Public, unauthenticated form page. `?embed=1` drops the page chrome for iframes. */
export function PublicFormPage() {
  const { uuid = '' } = useParams();
  const [params] = useSearchParams();
  const embed = params.get('embed') === '1';
  const { branding } = useBranding();
  const form = useQuery({
    queryKey: ['public-form', uuid],
    queryFn: () => apiGet<PublicForm>(`/public/forms/${uuid}`),
    retry: false,
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (form.data) setDocumentTitle(form.data.title, branding.appName);
  }, [form.data, branding.appName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setErrors({});
    try {
      // Public endpoint: no session and no CSRF token by design.
      const res = await fetch(`/api/v1/public/forms/${uuid}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = (await res.json()) as {
        message?: string;
        redirectUrl?: string | null;
        error?: { message: string; details?: { path: string; message: string }[] };
      };
      if (!res.ok) {
        const fe: Record<string, string> = {};
        for (const d of body.error?.details ?? []) fe[d.path.replace(/^custom\./, 'cf.')] = d.message;
        setErrors(Object.keys(fe).length ? fe : { _form: body.error?.message ?? 'Something went wrong' });
        return;
      }
      if (body.redirectUrl) window.top!.location.href = body.redirectUrl;
      else setDone(body.message ?? 'Thank you.');
    } catch (err) {
      setErrors({ _form: err instanceof ApiError ? err.message : 'Could not send. Check your connection.' });
    } finally {
      setSending(false);
    }
  };

  const set = (name: string, v: unknown) => setValues((x) => ({ ...x, [name]: v }));

  return (
    <div
      className={cn(
        'min-h-dvh',
        embed ? 'bg-transparent' : 'flex items-start justify-center bg-canvas px-4 py-10',
      )}
    >
      <div className={cn('w-full', !embed && 'max-w-lg rounded-lg border border-line bg-surface p-6 sm:p-8')}>
        {form.isPending ? (
          <Skeleton className="h-64" />
        ) : form.isError ? (
          <ErrorState error={new Error('This form is not available.')} />
        ) : done ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center" role="status">
            <CheckCircle2 className="size-8 text-primary" />
            <p className="text-lg font-medium">{done}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{form.data.title}</h1>
              {form.data.intro ? (
                <p className="mt-1 text-sm whitespace-pre-line text-muted">{form.data.intro}</p>
              ) : null}
            </div>
            {errors._form ? (
              <p role="alert" className="rounded-sm bg-accent-soft px-3 py-2 text-sm text-accent">
                {errors._form}
              </p>
            ) : null}
            {form.data.fields.map((f) => (
              <Field
                key={f.name}
                label={f.label}
                required={f.required}
                error={errors[f.name]}
                help={f.help || undefined}
              >
                {(p) =>
                  f.type === 'textarea' ? (
                    <Textarea
                      {...p}
                      placeholder={f.placeholder}
                      value={(values[f.name] as string) ?? ''}
                      onChange={(e) => set(f.name, e.target.value)}
                    />
                  ) : f.type === 'select' ? (
                    <NativeSelect
                      {...p}
                      value={(values[f.name] as string) ?? ''}
                      onChange={(e) => set(f.name, e.target.value || null)}
                    >
                      <option value="">Choose…</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : f.type === 'boolean' ? (
                    <input
                      id={p.id}
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={values[f.name] === true}
                      onChange={(e) => set(f.name, e.target.checked)}
                    />
                  ) : (
                    <Input
                      {...p}
                      type={
                        f.type === 'email'
                          ? 'email'
                          : f.type === 'phone'
                            ? 'tel'
                            : f.type === 'number' || f.type === 'decimal' || f.type === 'currency'
                              ? 'number'
                              : f.type === 'date'
                                ? 'date'
                                : f.type === 'url'
                                  ? 'url'
                                  : 'text'
                      }
                      placeholder={f.placeholder}
                      value={(values[f.name] as string) ?? ''}
                      onChange={(e) =>
                        set(
                          f.name,
                          ['number', 'decimal', 'currency'].includes(f.type)
                            ? e.target.value === ''
                              ? null
                              : Number(e.target.value)
                            : e.target.value,
                        )
                      }
                    />
                  )
                }
              </Field>
            ))}
            {/* Honeypot: hidden from people and assistive tech; bots fill it in. */}
            <div aria-hidden="true" className="absolute -start-[9999px] h-0 overflow-hidden">
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  name="website_url"
                  value={(values.website_url as string) ?? ''}
                  onChange={(e) => set('website_url', e.target.value)}
                />
              </label>
            </div>
            {form.data.consentText ? (
              <p className="text-xs whitespace-pre-line text-muted">{form.data.consentText}</p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" loading={sending}>
              {form.data.submitLabel}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
