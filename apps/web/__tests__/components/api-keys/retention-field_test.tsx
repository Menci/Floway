import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RetentionField, type RetentionValue } from '../../../src/components/api-keys/retention-field';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const DUMP_PRESETS = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 6 * 3600, label: '6 hours' },
  { seconds: 24 * 3600, label: '1 day' },
  { seconds: 7 * 86400, label: '7 days' },
] as const;

const RESPONSES_MAX_SECONDS = 10 * 365 * 86400;
const SECONDS_PER_DAY = 86400;

type FieldProps = Parameters<typeof RetentionField>[0];

// The field is controlled, so the harness plays the form the dialog wires it
// into: what the field emits is what it is handed back on the next render.
const renderField = (props: Partial<FieldProps> & { value: RetentionValue }) => {
  const onChange = vi.fn<(value: RetentionValue) => void>();

  function Host() {
    const [value, setValue] = useState<RetentionValue>(props.value);
    return (
      <RetentionField
        description="How long captured requests are kept"
        icon={null}
        label="Retention"
        offLabel="Do not capture"
        offValue={null}
        presets={DUMP_PRESETS}
        {...props}
        value={value}
        onChange={next => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  renderInApp(<Host />);
  return { input: screen.getByRole('combobox') as HTMLInputElement, onChange };
};

const type = (input: HTMLInputElement, text: string) => {
  fireEvent.change(input, { target: { value: text } });
};

// The control resolves a preset or a typed window into the number of seconds
// the gateway stores, and reports `invalid` rather than silently falling back
// -- a key that quietly kept data forever would be worse than one that refuses
// to save.
describe('retention field', () => {
  it('reads a preset back as its label', () => {
    expect(renderField({ value: 6 * 3600 }).input.value).toBe('6 hours');
  });

  it('reads the off value back as its label', () => {
    expect(renderField({ value: null }).input.value).toBe('Do not capture');
  });

  it('spells a window outside the presets in the duration grammar', () => {
    expect(renderField({ value: 90 * 60 }).input.value).toBe('90m');
  });

  it('emits the seconds behind a typed duration', () => {
    const { input, onChange } = renderField({ value: null });

    type(input, '30m');
    expect(onChange).toHaveBeenLastCalledWith(1800);

    type(input, '3d');
    expect(onChange).toHaveBeenLastCalledWith(259_200);

    type(input, '900');
    expect(onChange).toHaveBeenLastCalledWith(900);
  });

  it('reports a window that does not parse or resolves to nothing as invalid', () => {
    const { input, onChange } = renderField({ value: null });

    for (const text of ['soon', '0', '-1h', '']) {
      type(input, text);
      expect(onChange).toHaveBeenLastCalledWith('invalid');
    }
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('dashboard.apiKeys.retention.invalid'));
  });

  it('reads a days-unit window in whole days', () => {
    const { input, onChange } = renderField({
      customInputUnit: 'days',
      maximumSeconds: RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 0,
    });

    type(input, '14');
    expect(onChange).toHaveBeenLastCalledWith(14 * SECONDS_PER_DAY);

    type(input, '1');
    expect(onChange).toHaveBeenLastCalledWith(SECONDS_PER_DAY);
  });

  it('rejects a days-unit window below the minimum, past the ceiling, or not a whole day', () => {
    const { input, onChange } = renderField({
      customInputUnit: 'days',
      maximumSeconds: RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 0,
    });

    for (const text of ['0', '3651', '1.5', '7d']) {
      type(input, text);
      expect(onChange).toHaveBeenLastCalledWith('invalid');
    }
  });

  it('refuses a null window on a field whose off value is zero', () => {
    expect(() => renderField({ offValue: 0, value: null })).toThrow(TypeError);
  });
});
