import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import type { EntityConfig, FieldConfig } from './entities';

type Rec = Record<string, unknown> & { uuid: string; custom: Record<string, unknown> };

const field = (key: string, label: string, render?: FieldConfig<Rec>['render']): FieldConfig<Rec> => ({
  key,
  label,
  kind: 'text',
  get: (r) => r[key],
  render,
  input: key,
});

const fields = [
  field('firstName', 'First name'),
  field('phone', 'Phone'),
  field('tags', 'Tags', (r) =>
    (r.tags as string[]).length ? <span>{(r.tags as string[]).join(', ')}</span> : null,
  ),
  field('verified', 'ID verified'),
];

vi.mock('@/app/session', () => ({
  useCan: () => () => true,
  useT: () => (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string,
}));
vi.mock('./api', () => ({
  useRecordMutations: () => ({ update: { mutateAsync: vi.fn(), mutate: vi.fn() } }),
}));
vi.mock('./record-form', () => ({
  FieldInputControl: () => null,
  useFormSections: () => [{ key: 'details', label: 'Details', fields }],
}));

const { FieldsPanel } = await import('./fields-panel');

const config = { resource: 'core.contacts', route: 'contacts' } as unknown as EntityConfig;
const base: Rec = { uuid: 'u1', custom: {}, firstName: 'Mei', phone: '', tags: [], verified: false };

afterEach(cleanup);

describe('FieldsPanel empty fields', () => {
  it('hides empty fields and offers to show them with a count', () => {
    render(<FieldsPanel config={config} record={base} />);
    expect(screen.getByText('First name')).toBeInTheDocument();
    expect(screen.queryByText('Phone')).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 3 empty fields' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('uses the singular for one empty field', () => {
    render(<FieldsPanel config={config} record={{ ...base, phone: '1', tags: ['vip'] }} />);
    expect(screen.getByRole('button', { name: 'Show 1 empty field' })).toBeInTheDocument();
  });

  it('has no toggle when every field is filled in', () => {
    render(<FieldsPanel config={config} record={{ ...base, phone: '1', tags: ['vip'], verified: true }} />);
    expect(screen.queryByRole('button', { name: /empty field/ })).toBeNull();
  });

  it('shows every field after the toggle, with a dash for an empty renderer result, then hides again', async () => {
    const user = userEvent.setup();
    render(<FieldsPanel config={config} record={base} />);
    await user.click(screen.getByRole('button', { name: 'Show 3 empty fields' }));
    expect(screen.getByText('Phone')).toBeInTheDocument();
    // Tags renders nothing for an empty list; the row still shows a dash instead of a blank.
    expect(screen.getByLabelText('Edit Tags')).toHaveTextContent('—');
    await user.click(screen.getByRole('button', { name: 'Hide empty fields' }));
    expect(screen.queryByText('Phone')).toBeNull();
  });

  it('shows everything, with no toggle, when nothing is filled in yet', () => {
    render(<FieldsPanel config={config} record={{ uuid: 'u2', custom: {}, tags: [] }} />);
    expect(screen.getByText('First name')).toBeInTheDocument();
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /empty fields/ })).toBeNull();
  });
});
