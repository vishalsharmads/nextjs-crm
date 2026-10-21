import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type Resolver, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ImageUp, Trash2 } from 'lucide-react';
import {
  BRANDING_ASSET_SLOTS,
  FONT_FAMILIES,
  brandingSchema,
  checkPaletteContrast,
  type Branding,
  type BrandingAssetSlot,
  type ContrastWarning,
  type Palette,
} from '@app/shared';
import { api, apiDelete, apiGet, apiPut } from '@/lib/api';
import { useBranding } from '@/app/branding';
import { useT } from '@/app/session';
import { paletteVars } from '@/theme/apply';
import { FACTORY_THEME } from '@/theme/defaults';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Pane, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';
import { SettingsPage } from './layout';

interface BrandingResponse {
  branding: Branding;
  assets: Partial<Record<BrandingAssetSlot, string>>;
  warnings: ContrastWarning[];
}

const COLOR_KEYS: { key: keyof Palette; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent', label: 'Accent' },
  { key: 'canvas', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'ink', label: 'Text' },
  { key: 'line', label: 'Borders' },
];

const SLOT_LABELS: Record<BrandingAssetSlot, { label: string; help: string }> = {
  logoLight: { label: 'Logo (light mode)', help: 'PNG, JPEG or WebP, about 160×32.' },
  logoDark: { label: 'Logo (dark mode)', help: 'Optional. Falls back to the light logo.' },
  favicon: { label: 'Favicon', help: 'Square PNG or ICO, 64×64 or larger.' },
  loginBackground: { label: 'Sign-in background', help: 'Large image shown beside the sign-in form.' },
};

export function BrandingPage() {
  const t = useT();
  const q = useQuery({
    queryKey: ['settings', 'branding'],
    queryFn: () => apiGet<BrandingResponse>('/settings/branding'),
  });
  return (
    <SettingsPage
      title={t('settings.branding')}
      description="Everything people see: name, logo, colors and type. Changes apply instantly, no rebuild."
    >
      {q.data ? <BrandingForm initial={q.data} /> : <Skeleton className="h-96" />}
    </SettingsPage>
  );
}

function BrandingForm({ initial }: { initial: BrandingResponse }) {
  const qc = useQueryClient();
  const { branding: live, preview } = useBranding();
  const [previewOn, setPreviewOn] = useState(false);
  const form = useForm<Branding>({
    resolver: zodResolver(brandingSchema) as unknown as Resolver<Branding>,
    defaultValues: initial.branding,
  });
  const values = useWatch({ control: form.control }) as Branding;
  const warnings = useMemo(() => (values.colors ? checkPaletteContrast(values.colors) : []), [values.colors]);

  useEffect(() => {
    if (previewOn) preview({ ...live, ...values, assets: live.assets });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOn, values]);
  useEffect(() => () => preview(null), [preview]);

  const save = useMutation({
    mutationFn: (b: Branding) => apiPut<BrandingResponse>('/settings/branding', b),
    onSuccess: (res) => {
      toast.success(
        res.warnings.length ? 'Saved. Some colors fall below recommended contrast.' : 'Branding saved',
      );
      setPreviewOn(false);
      preview(null);
      void qc.invalidateQueries({ queryKey: ['public', 'branding'] });
      void qc.invalidateQueries({ queryKey: ['settings', 'branding'] });
    },
  });

  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={previewOn} onCheckedChange={setPreviewOn} />
          Preview across the app
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => form.reset(initial.branding)}
            disabled={!form.formState.isDirty}
          >
            Discard
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save branding
          </Button>
        </div>
      </div>

      <Pane title="Identity">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="App name" required error={form.formState.errors.appName?.message}>
            {(p) => <Input {...p} {...form.register('appName')} />}
          </Field>
          <Field label="Tagline">{(p) => <Input {...p} {...form.register('tagline')} />}</Field>
          <Field label="Sign-in title" help="Defaults to the app name.">
            {(p) => <Input {...p} {...form.register('loginTitle')} />}
          </Field>
          <Field label="Sign-in tagline">{(p) => <Input {...p} {...form.register('loginTagline')} />}</Field>
          <Field label="Footer text">{(p) => <Input {...p} {...form.register('footerText')} />}</Field>
          <Field label="Document header" help="Printed at the top of generated PDFs.">
            {(p) => <Input {...p} {...form.register('pdfHeader')} />}
          </Field>
        </div>
      </Pane>

      <Pane title="Images">
        <div className="grid gap-4 sm:grid-cols-2">
          {BRANDING_ASSET_SLOTS.map((slot) => (
            <AssetSlot key={slot} slot={slot} url={live.assets[slot]} />
          ))}
        </div>
      </Pane>

      <Pane title="Colors">
        <ContrastWarnings warnings={warnings} />
        <div className="grid gap-6 lg:grid-cols-2">
          {(['light', 'dark'] as const).map((mode) => (
            <div key={mode} className="flex flex-col gap-3">
              <p className="text-sm font-medium">{mode === 'light' ? 'Light mode' : 'Dark mode'}</p>
              <div className="grid grid-cols-2 gap-3">
                {COLOR_KEYS.map((c) => (
                  <ColorInput key={c.key} form={form} name={`colors.${mode}.${c.key}`} label={c.label} />
                ))}
              </div>
              {values.colors?.[mode] ? (
                <PalettePreview palette={values.colors[mode]} radius={values.radius} />
              ) : null}
            </div>
          ))}
        </div>
      </Pane>

      <Pane title="Type and shape">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Font">
            {(p) => (
              <NativeSelect {...p} {...form.register('fontFamily')}>
                {FONT_FAMILIES.map((f) => (
                  <option key={f} value={f}>
                    {f === 'system-ui' ? 'System default' : f}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={`Corner radius (${values.radius ?? 0}px)`}>
            {(p) => (
              <input
                {...p}
                type="range"
                min={0}
                max={16}
                step={1}
                className="mt-2 accent-[var(--primary)]"
                {...form.register('radius', { valueAsNumber: true })}
              />
            )}
          </Field>
        </div>
      </Pane>

      <Pane title="Email sender">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sender name" help="Defaults to the app name.">
            {(p) => <Input {...p} {...form.register('emailFromName')} />}
          </Field>
          <Field
            label="Sender address"
            error={form.formState.errors.emailFromAddress?.message}
            help="Must be allowed by your mail server."
          >
            {(p) => <Input {...p} type="email" {...form.register('emailFromAddress')} />}
          </Field>
        </div>
      </Pane>
    </form>
  );
}

function ColorInput({
  form,
  name,
  label,
}: {
  form: UseFormReturn<Branding>;
  name: `colors.${'light' | 'dark'}.${keyof Palette}`;
  label: string;
}) {
  const value = (useWatch({ control: form.control, name }) as string) ?? '';
  const error = name
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], form.formState.errors) as
    { message?: string } | undefined;
  return (
    <Field label={label} error={error?.message}>
      {(p) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : FACTORY_THEME.colors.light.ink}
            onChange={(e) =>
              form.setValue(name, e.target.value.toUpperCase(), { shouldDirty: true, shouldValidate: true })
            }
            className="size-8 shrink-0 cursor-pointer rounded-sm border border-line bg-surface p-0.5"
          />
          <Input {...p} {...form.register(name)} className="font-mono text-xs uppercase" />
        </div>
      )}
    </Field>
  );
}

function ContrastWarnings({ warnings }: { warnings: ContrastWarning[] }) {
  if (!warnings.length)
    return <p className="mb-4 text-xs text-muted">All color pairs meet WCAG AA contrast.</p>;
  return (
    <div role="status" className="mb-4 rounded-sm border border-accent bg-accent-soft p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-accent">
        <AlertTriangle className="size-4" /> Some combinations are hard to read
      </p>
      <ul className="mt-1.5 list-inside list-disc text-ink">
        {warnings.map((w) => (
          <li key={`${w.mode}-${w.pair}`}>
            {w.mode === 'light' ? 'Light' : 'Dark'}: {w.pair} is {w.ratio}:1 (needs {w.required}:1)
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A miniature of the real UI rendered with the candidate palette. */
function PalettePreview({ palette, radius }: { palette: Palette; radius: number }) {
  const vars = { ...paletteVars(palette), '--radius': `${radius}px` } as React.CSSProperties;
  return (
    <div style={vars} className="rounded-md border border-line bg-canvas p-3 text-ink">
      <div className="rounded-md border border-line bg-surface p-3">
        <p className="text-sm font-semibold">Sample record</p>
        <p className="mt-0.5 text-xs text-muted">Secondary text reads like this.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="inline-flex h-7 items-center rounded-sm bg-primary px-2.5 text-xs font-medium text-primary-fg">
            Primary action
          </span>
          <span className="inline-flex h-7 items-center rounded-sm border border-line px-2.5 text-xs">
            Secondary
          </span>
          <span className="inline-flex h-5 items-center rounded-sm bg-accent-soft px-1.5 text-2xs font-medium text-accent">
            Overdue
          </span>
        </div>
      </div>
    </div>
  );
}

function AssetSlot({ slot, url }: { slot: BrandingAssetSlot; url?: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api(`/settings/branding/assets/${slot}`, { method: 'POST', body: fd });
    },
    onSuccess: () => {
      toast.success('Image uploaded');
      void qc.invalidateQueries({ queryKey: ['public', 'branding'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/settings/branding/assets/${slot}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['public', 'branding'] }),
  });
  const meta = SLOT_LABELS[slot];
  return (
    <div className="flex items-center gap-3 rounded-sm border border-line p-3">
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-subtle">
        {url ? (
          <img src={url} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <ImageUp className="size-5 text-faint" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{meta.label}</p>
        <p className="text-xs text-muted">{meta.help}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon"
        className="sr-only"
        aria-label={`Upload ${meta.label}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = '';
        }}
      />
      <Button type="button" size="sm" onClick={() => input.current?.click()} loading={upload.isPending}>
        {url ? 'Replace' : 'Upload'}
      </Button>
      {url ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${meta.label}`}
          onClick={() => remove.mutate()}
        >
          <Trash2 />
        </Button>
      ) : null}
    </div>
  );
}
