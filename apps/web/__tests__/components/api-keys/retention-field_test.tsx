import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RetentionField, type RetentionValue } from '../../../src/components/api-keys/retention-field';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const DUMP_PRESETS = [
  { seconds: 3600 },
  { seconds: 6 * 3600 },
  { seconds: 24 * 3600 },
  { seconds: 7 * 86400 },
] as const;

const OPENAI_RESPONSES_MAX_SECONDS = 10 * 365 * 86400;
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
  input.setSelectionRange(0, input.value.length);
  fireEvent.keyDown(input, { key: 'Unidentified' });
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  fireEvent.input(input);
};

// The control resolves a preset or a typed window into the number of seconds
// the gateway stores, and reports `invalid` rather than silently falling back
// -- a key that quietly kept data forever would be worse than one that refuses
// to save.
describe('retention field', () => {
  it('emits the seconds behind a typed duration', () => {
    const { input, onChange } = renderField({ value: null });

    type(input, '2');
    expect(onChange).toHaveBeenLastCalledWith(2 * 3600);
    expect(input.value).toBe('2 hours');

    type(input, '30m');
    expect(onChange).toHaveBeenLastCalledWith(1800);
    expect(input.value).toBe('30 minutes');

    type(input, '3d');
    expect(onChange).toHaveBeenLastCalledWith(259_200);
    expect(input.value).toBe('3 days');

    type(input, '900');
    expect(onChange).toHaveBeenLastCalledWith(900 * 3600);
    expect(input.value).toBe('900 hours');
  });

  it('reports a window that does not parse or resolves to nothing as invalid', () => {
    const { input, onChange } = renderField({ value: null });

    input.focus();
    for (const text of ['soon', '-1h', '']) {
      type(input, text);
      expect(onChange).toHaveBeenLastCalledWith('invalid');
      expect(document.activeElement).toBe(input);
    }
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('apiKeys.retention.invalid'));
  });

  it('enforces the configured range and whole-day granularity', () => {
    const { input, onChange } = renderField({
      defaultUnit: 'd',
      maximumSeconds: OPENAI_RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      multipleOfSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 0,
    });

    for (const text of ['3651', '1.5', '25h']) {
      type(input, text);
      expect(onChange).toHaveBeenLastCalledWith('invalid');
    }
  });
});
