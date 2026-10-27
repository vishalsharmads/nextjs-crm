import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import i18n from 'i18next';
import type { MergeFieldGroup } from '@app/shared';
import { TooltipProvider } from '@/components/ui/menu';

vi.mock('@/app/session', () => ({
  useT: () => (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string,
}));

const { RichTextEditor } = await import('./rich-text-editor');

function Harness({
  initial,
  onChange,
  ...rest
}: { initial: string; onChange?: (html: string) => void } & Partial<Parameters<typeof RichTextEditor>[0]>) {
  const [value, setValue] = useState(initial);
  return (
    <TooltipProvider>
      <RichTextEditor
        aria-label="Body"
        {...rest}
        value={value}
        onChange={(html) => {
          setValue(html);
          onChange?.(html);
        }}
      />
    </TooltipProvider>
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });
const fields: MergeFieldGroup[] = [
  { key: 'contact', label: 'Contact', fields: [{ path: 'contact.firstName', label: 'First name' }] },
];

afterEach(cleanup);

describe('RichTextEditor', () => {
  it('shows the HTML as formatted text in the visual view', () => {
    render(<Harness initial="<p>Hello <strong>there</strong></p>" />);
    expect(screen.getByRole('textbox', { name: 'Body' }).querySelector('strong')).toHaveTextContent('there');
    expect(tab('Visual')).toHaveAttribute('aria-selected', 'true');
  });

  it('applies bold from the toolbar', async () => {
    const onChange = vi.fn();
    render(<Harness initial="<p>Word</p>" onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: 'Body' });
    const editor = (box as unknown as { editor?: { commands: { selectAll: () => void } } }).editor;
    act(() => editor?.commands.selectAll());
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('<p><strong>Word</strong></p>'));
  });

  it('converts Markdown typed in the Markdown view to HTML', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="" onChange={onChange} />);
    await user.click(tab('Markdown'));
    const source = screen.getByRole('textbox', { name: 'Body (Markdown)' });
    await user.type(source, '**Hi** _there_');
    expect(onChange).toHaveBeenLastCalledWith('<p><strong>Hi</strong> <em>there</em></p>');
    await user.click(tab('Visual'));
    expect(screen.getByRole('textbox', { name: 'Body' }).querySelector('em')).toHaveTextContent('there');
  });

  it('passes HTML typed in the HTML view straight through', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="<p>a</p>" onChange={onChange} />);
    await user.click(tab('HTML'));
    const source = screen.getByRole('textbox', { name: 'Body (HTML)' });
    expect(source).toHaveValue('<p>a</p>');
    await user.clear(source);
    await user.type(source, '<p>b</p>');
    expect(onChange).toHaveBeenLastCalledWith('<p>b</p>');
  });

  it('opens a template with block helpers as HTML and keeps it there', () => {
    render(<Harness initial="{{#if deal}}<p>{{deal.title}}</p>{{/if}}" mergeFields={fields} />);
    expect(tab('HTML')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Visual')).toBeDisabled();
    expect(screen.getByText(/opens as HTML/)).toBeInTheDocument();
  });

  it('shows placeholders as chips and stores them as plain Handlebars text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="<p>Hi {{contact.firstName}}</p>" mergeFields={fields} onChange={onChange} />);
    const chip = screen.getByRole('textbox', { name: 'Body' }).querySelector('[data-merge-field]');
    expect(chip).toHaveTextContent('{{contact.firstName}}');
    await user.click(tab('HTML'));
    expect(screen.getByRole('textbox', { name: 'Body (HTML)' })).toHaveValue(
      '<p>Hi {{contact.firstName}}</p>',
    );
  });

  it('replaces its content when the value is reset from outside', () => {
    const ui = (value: string) => (
      <TooltipProvider>
        <RichTextEditor aria-label="Body" value={value} onChange={() => {}} />
      </TooltipProvider>
    );
    const { rerender } = render(ui('<p>Draft</p>'));
    rerender(ui(''));
    expect(screen.getByRole('textbox', { name: 'Body' })).not.toHaveTextContent('Draft');
  });

  it('offers the insert buttons only when fields or replies are given', () => {
    render(<Harness initial="" />);
    expect(screen.queryByRole('button', { name: 'Insert field' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert saved reply' })).toBeNull();
    cleanup();
    render(
      <Harness initial="" mergeFields={fields} replies={{ items: [], insert: () => Promise.resolve('') }} />,
    );
    expect(screen.getByRole('button', { name: 'Insert field' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insert saved reply' })).toBeInTheDocument();
  });
});
