import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CustomFieldDef } from '@app/shared';
import { CustomFieldDisplay, CustomFieldInput } from './custom-field';

const def = (p: Partial<CustomFieldDef>): CustomFieldDef => ({
  uuid: 'u',
  entity: 'contact',
  key: 'k',
  label: 'Field',
  type: 'text',
  group: null,
  options: [],
  currency: null,
  placeholder: null,
  helpText: null,
  required: false,
  defaultValue: null,
  validation: {},
  visibility: { default: 'write', roles: {} },
  filterable: false,
  showInList: false,
  sortOrder: 0,
  active: true,
  sourceBlueprint: null,
  sensitivity: 'normal',
  customized: false,
  ...p,
});

describe('custom field display', () => {
  it('shows option labels, not stored keys', () => {
    render(
      <CustomFieldDisplay
        def={def({ type: 'select', options: [{ key: 'hot_desk', label: 'Hot desk', active: true }] })}
        value="hot_desk"
      />,
    );
    expect(screen.getByText('Hot desk')).toBeInTheDocument();
    expect(screen.queryByText('hot_desk')).toBeNull();
  });

  it('renders multi-select values and booleans accessibly', () => {
    const { container } = render(
      <>
        <CustomFieldDisplay
          def={def({
            type: 'multi_select',
            options: [
              { key: 'a', label: 'Alpha', active: true },
              { key: 'b', label: 'Beta', active: true },
            ],
          })}
          value={['a', 'b']}
        />
        <CustomFieldDisplay def={def({ type: 'boolean' })} value={true} />
      </>,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Yes"]')).not.toBeNull();
  });

  it('formats money with the field currency and shows a dash when empty', () => {
    render(
      <>
        <CustomFieldDisplay def={def({ type: 'currency', currency: 'GBP' })} value={1600} />
        <CustomFieldDisplay def={def({ type: 'text' })} value={null} />
      </>,
    );
    expect(screen.getByText(/1,600/)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('only links safe URL values', () => {
    render(<CustomFieldDisplay def={def({ type: 'url' })} value="https://example.test/path" />);
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('custom field input', () => {
  it('emits numbers for number fields and null when cleared', () => {
    const onChange = vi.fn();
    render(
      <CustomFieldInput
        def={def({ type: 'number', label: 'Seats' })}
        value={2}
        onChange={onChange}
        id="seats"
      />,
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('uses a date input for date fields and clears to null', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CustomFieldInput def={def({ type: 'date' })} value="2026-01-02" onChange={onChange} />,
    );
    const input = container.querySelector('input[type="date"]')!;
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('disables inputs for read-only access', () => {
    render(<CustomFieldInput def={def({ type: 'text' })} value="x" onChange={() => undefined} disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
