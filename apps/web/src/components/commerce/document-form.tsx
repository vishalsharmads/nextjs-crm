import { useState } from 'react';
import { useBoot, useCan } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Pane } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';
import { LineItemsEditor, newLine, toInput, type EditableLine } from './line-items';
import type { RecordRef } from './document-paper';

export interface DocumentFormValues {
  title: string;
  organization: RecordRef | null;
  contact: RecordRef | null;
  deal: RecordRef | null;
  currency: string;
  dates: Record<string, string>;
  notes: string;
  terms: string;
  lines: EditableLine[];
}

export function emptyDocument(currency: string, defaultTaxRate: number): DocumentFormValues {
  return {
    title: '',
    organization: null,
    contact: null,
    deal: null,
    currency,
    dates: {},
    notes: '',
    terms: '',
    lines: [newLine(defaultTaxRate)],
  };
}

/** Body for POST/PATCH of quotes and invoices. Empty dates are left out so the server applies defaults. */
export function toDocumentBody(v: DocumentFormValues) {
  const dates = Object.fromEntries(Object.entries(v.dates).filter(([, d]) => d));
  return {
    title: v.title,
    organizationUuid: v.organization?.uuid ?? null,
    contactUuid: v.contact?.uuid ?? null,
    dealUuid: v.deal?.uuid ?? null,
    currency: v.currency,
    notes: v.notes || null,
    terms: v.terms || null,
    lines: toInput(v.lines),
    ...dates,
  };
}

/** Shared editor for commercial documents: who it is for, dates, lines, notes and terms. */
export function DocumentForm({
  initial,
  dateFields,
  submitLabel,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  initial: DocumentFormValues;
  dateFields: { key: string; label: string; help?: string }[];
  submitLabel: string;
  submitting: boolean;
  error: unknown;
  onSubmit: (v: DocumentFormValues) => void;
  onCancel: () => void;
}) {
  const boot = useBoot();
  const can = useCan();
  const L = labelVars(boot.labels);
  const [v, setV] = useState(initial);
  const set = <K extends keyof DocumentFormValues>(k: K, val: DocumentFormValues[K]) =>
    setV((s) => ({ ...s, [k]: val }));
  const fieldErrors = new Map(Object.entries(error instanceof ApiError ? error.fieldErrors() : {}));
  const ref = (uuid: string | null, name?: string): RecordRef | null =>
    uuid ? { uuid, name: name ?? '' } : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
      noValidate
    >
      <Pane title="Details">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Title" className="md:col-span-2">
            {(p) => (
              <Input
                {...p}
                value={v.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="What is this for?"
                maxLength={200}
              />
            )}
          </Field>
          {can('core.organizations.view') ? (
            <Field label={L.organization} error={fieldErrors.get('organizationUuid')}>
              {(p) => (
                <RecordPicker
                  {...p}
                  route="organizations"
                  value={v.organization?.uuid ?? null}
                  label={v.organization?.name}
                  onChange={(uuid, name) => set('organization', ref(uuid, name))}
                />
              )}
            </Field>
          ) : null}
          {can('core.contacts.view') ? (
            <Field label={L.contact} error={fieldErrors.get('contactUuid')}>
              {(p) => (
                <RecordPicker
                  {...p}
                  route="contacts"
                  value={v.contact?.uuid ?? null}
                  label={v.contact?.name}
                  onChange={(uuid, name) => set('contact', ref(uuid, name))}
                />
              )}
            </Field>
          ) : null}
          {can('core.deals.view') ? (
            <Field label={L.deal} error={fieldErrors.get('dealUuid')}>
              {(p) => (
                <RecordPicker
                  {...p}
                  route="deals"
                  value={v.deal?.uuid ?? null}
                  label={v.deal?.name}
                  onChange={(uuid, name) => set('deal', ref(uuid, name))}
                />
              )}
            </Field>
          ) : null}
          <Field label="Currency" help="Three-letter code, for example USD or EUR.">
            {(p) => (
              <Input
                {...p}
                value={v.currency}
                onChange={(e) => set('currency', e.target.value.toUpperCase().slice(0, 3))}
                className="w-24 uppercase"
              />
            )}
          </Field>
          {dateFields.map((d) => (
            <Field key={d.key} label={d.label} help={d.help} error={fieldErrors.get(d.key)}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={v.dates[d.key] ?? ''}
                  onChange={(e) => set('dates', { ...v.dates, [d.key]: e.target.value })}
                  className="w-44"
                />
              )}
            </Field>
          ))}
        </div>
      </Pane>

      <Pane title="Lines">
        <LineItemsEditor
          lines={v.lines}
          onChange={(lines) => set('lines', lines)}
          currency={v.currency}
          canUseProducts={boot.modules.enabled.includes('products') && can('products.products.view')}
          defaultTaxRate={boot.settings.commerce.defaultTaxRate}
        />
      </Pane>

      <Pane title="Notes and terms">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Notes" help="Shown to the customer.">
            {(p) => <Textarea {...p} value={v.notes} onChange={(e) => set('notes', e.target.value)} />}
          </Field>
          <Field label="Terms" help="Leave empty to use the default terms.">
            {(p) => <Textarea {...p} value={v.terms} onChange={(e) => set('terms', e.target.value)} />}
          </Field>
        </div>
      </Pane>

      {error && !fieldErrors.size ? (
        <p role="alert" className="text-sm text-accent">
          {error instanceof Error ? error.message : 'Something went wrong. Try again.'}
        </p>
      ) : null}
      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
