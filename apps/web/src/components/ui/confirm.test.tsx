import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmHost, askText, confirmAction } from './confirm';

describe('confirmAction', () => {
  afterEach(cleanup);
  it('resolves true on the action button and false on cancel or Escape', async () => {
    render(<ConfirmHost />);
    let p!: Promise<boolean>;
    act(() => {
      p = confirmAction({ title: 'Delete draft 12?', action: 'Delete', danger: true });
    });
    expect(await screen.findByRole('dialog', { name: 'Delete draft 12?' })).toBeTruthy();
    // The action has focus, so Enter confirms.
    expect(document.activeElement?.textContent).toBe('Delete');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(p).resolves.toBe(true);

    act(() => {
      p = confirmAction({ title: 'Void it?', action: 'Void' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(p).resolves.toBe(false);

    act(() => {
      p = confirmAction({ title: 'Remove?', action: 'Remove' });
    });
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Remove?' }), { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('asks for text with a labelled box', async () => {
    render(<ConfirmHost />);
    let p!: Promise<string | null>;
    act(() => {
      p = askText({ title: 'Reject this document?', label: 'What should they fix?', action: 'Reject' });
    });
    fireEvent.change(await screen.findByLabelText('What should they fix?'), {
      target: { value: 'Blurry scan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await expect(p).resolves.toBe('Blurry scan');
  });
});
