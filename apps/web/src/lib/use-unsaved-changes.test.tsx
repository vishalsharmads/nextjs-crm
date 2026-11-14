import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { ConfirmHost } from '@/components/ui/confirm';
import { useUnsavedChanges } from './use-unsaved-changes';

function Editor() {
  const [text, setText] = useState('');
  useUnsavedChanges(text !== '');
  return (
    <>
      <input aria-label="Name" value={text} onChange={(e) => setText(e.target.value)} />
      <Link to="/other">Elsewhere</Link>
    </>
  );
}

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Editor /> },
      { path: '/other', element: <p>Other page</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <>
      <RouterProvider router={router} />
      <ConfirmHost />
    </>,
  );
}

describe('useUnsavedChanges', () => {
  afterEach(cleanup);

  it('leaves freely when nothing changed', async () => {
    setup();
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(await screen.findByText('Other page')).toBeTruthy();
  });

  it('asks before leaving with changes, and stays or leaves as chosen', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByText('Elsewhere'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft');
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.click(screen.getByText('Elsewhere'));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Other page')).toBeTruthy();
  });
});
