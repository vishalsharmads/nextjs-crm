import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CommerceSettings } from '@app/shared';
import { apiGet, apiPatch } from '@/lib/api';
import { bootstrapKey, useBoot } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Pane, Skeleton } from '@/components/ui/misc';
import { SettingsPage } from './layout';

/** Business details and defaults printed on quotes, invoices and contracts. */
export function CommerceSettingsPage() {
  const q = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: () => apiGet<{ commerce: CommerceSettings }>('/settings'),
  });
  return (
    <SettingsPage
      title="Sales documents"
      description="Your business details and the defaults used on quotes, invoices and contracts."
    >
      {q.data ? <CommerceForm initial={q.data.commerce} /> : <Skeleton className="h-96" />}
    </SettingsPage>
  );
}

function CommerceForm({ initial }: { initial: CommerceSettings }) {
  const qc = useQueryClient();
  const { modules } = useBoot();
  const on = (k: string) => modules.enabled.includes(k);
  const form = useForm<CommerceSettings>({ defaultValues: initial });
  const save = useMutation({
    mutationFn: (v: CommerceSettings) =>
      apiPatch<CommerceSettings>('/settings/commerce', {
        ...v,
        quoteValidityDays: Number(v.quoteValidityDays),
        invoiceDueDays: Number(v.invoiceDueDays),
        defaultTaxRate: Number(v.defaultTaxRate),
        renewalNoticeDays: Number(v.renewalNoticeDays),
      }),
    onSuccess: (v) => {
      toast.success('Saved');
      form.reset(v);
      void qc.invalidateQueries({ queryKey: ['settings', 'all'] });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  const r = form.register;
  return (
    <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Pane
        title="Business details"
        actions={<span className="text-xs text-muted">Printed on every document</span>}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Legal name">{(p) => <Input {...p} {...r('legalName')} />}</Field>
          <Field label="Tax or registration number">{(p) => <Input {...p} {...r('taxId')} />}</Field>
          <Field label="Billing email">{(p) => <Input {...p} type="email" {...r('email')} />}</Field>
          <Field label="Phone">{(p) => <Input {...p} {...r('phone')} />}</Field>
          <Field label="Address" className="md:col-span-2">
            {(p) => <Textarea {...p} rows={3} {...r('address')} />}
          </Field>
        </div>
      </Pane>
      <Pane title="Numbering and defaults">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Default tax %">
            {(p) => <Input {...p} type="number" step="0.001" min={0} max={100} {...r('defaultTaxRate')} />}
          </Field>
          {on('quotes') ? (
            <>
              <Field label="Quote number prefix" help="For example Q- gives Q-0001.">
                {(p) => <Input {...p} {...r('quotePrefix')} />}
              </Field>
              <Field label="Quotes valid for (days)">
                {(p) => <Input {...p} type="number" min={1} max={365} {...r('quoteValidityDays')} />}
              </Field>
            </>
          ) : null}
          {on('invoices') ? (
            <>
              <Field label="Invoice number prefix">{(p) => <Input {...p} {...r('invoicePrefix')} />}</Field>
              <Field label="Payment due after (days)">
                {(p) => <Input {...p} type="number" min={0} max={365} {...r('invoiceDueDays')} />}
              </Field>
            </>
          ) : null}
          {on('contracts') ? (
            <>
              <Field label="Contract number prefix">{(p) => <Input {...p} {...r('contractPrefix')} />}</Field>
              <Field label="Renewal reminder (days before end)">
                {(p) => <Input {...p} type="number" min={1} max={365} {...r('renewalNoticeDays')} />}
              </Field>
            </>
          ) : null}
        </div>
      </Pane>
      <Pane title="Default text">
        <div className="grid gap-4 md:grid-cols-2">
          {on('quotes') ? (
            <Field label="Quote terms">{(p) => <Textarea {...p} rows={4} {...r('quoteTerms')} />}</Field>
          ) : null}
          {on('invoices') ? (
            <>
              <Field label="Invoice terms">
                {(p) => <Textarea {...p} rows={4} {...r('invoiceTerms')} />}
              </Field>
              <Field label="Payment instructions" help="Bank details or how to pay. Printed on invoices.">
                {(p) => <Textarea {...p} rows={4} {...r('paymentInstructions')} />}
              </Field>
            </>
          ) : null}
        </div>
      </Pane>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!form.formState.isDirty}>
          Save
        </Button>
      </div>
    </form>
  );
}
