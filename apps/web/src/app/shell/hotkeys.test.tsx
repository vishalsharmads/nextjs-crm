import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useHotkeys } from './hotkeys';

function Harness({ onEnter, onC }: { onEnter: () => void; onC: () => void }) {
  useHotkeys({ Enter: onEnter, c: onC });
  return (
    <div>
      <button onClick={() => undefined}>Action</button>
      <a href="#x">Link</a>
      <div role="menuitem" tabIndex={0}>
        Item
      </div>
      <input aria-label="Field" />
    </div>
  );
}

afterEach(cleanup);

describe('useHotkeys', () => {
  it('runs a shortcut when focus is on the page', async () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} onC={vi.fn()} />);
    await userEvent.setup().keyboard('{Enter}');
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter alone on a focused button, link or menu item', async () => {
    const onEnter = vi.fn();
    const onClick = vi.fn();
    render(<Harness onEnter={onEnter} onC={vi.fn()} />);
    screen.getByRole('button', { name: 'Action' }).addEventListener('click', onClick);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Action' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.tab();
    await user.keyboard('{Enter}');
    await user.tab();
    expect(screen.getByRole('menuitem')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('still ignores keys typed in a field, and still runs letter shortcuts from a button', async () => {
    const onC = vi.fn();
    render(<Harness onEnter={vi.fn()} onC={onC} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Field'));
    await user.keyboard('c');
    expect(onC).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Action' }).focus();
    await user.keyboard('c');
    expect(onC).toHaveBeenCalledTimes(1);
  });
});

describe('modifier shortcuts', () => {
  function Mod({ onJ, onC }: { onJ: () => void; onC: () => void }) {
    useHotkeys({ 'mod+j': onJ, c: onC });
    return <input aria-label="Field" />;
  }

  it('run with Ctrl or ⌘, even while typing, while plain keys do not', async () => {
    const onJ = vi.fn();
    const onC = vi.fn();
    render(<Mod onJ={onJ} onC={onC} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'Field' }));
    await user.keyboard('{Control>}j{/Control}');
    await user.keyboard('{Meta>}j{/Meta}');
    await user.keyboard('c');
    expect(onJ).toHaveBeenCalledTimes(2);
    expect(onC).not.toHaveBeenCalled();
  });
});
