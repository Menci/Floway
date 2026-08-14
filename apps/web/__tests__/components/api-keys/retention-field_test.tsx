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
  input.setSelectionRange(0, input.value.length);
  fireEvent.keyDown(input, { key: 'Unidentified' });
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  fireEvent.input(input);
};

const editAtSelection = (
  input: HTMLInputElement,
  value: string,
  previousSelectionStart: number,
  previousSelectionEnd: number,
  selectionStart: number,
  selectionEnd = selectionStart,
) => {
  input.setSelectionRange(previousSelectionStart, previousSelectionEnd);
  fireEvent.keyDown(input, { key: 'Unidentified' });
  input.value = value;
  input.setSelectionRange(selectionStart, selectionEnd);
  fireEvent.input(input);
};

const insertText = (input: HTMLInputElement, text: string) => {
  input.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: text,
    inputType: 'insertText',
  }));
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.setSelectionRange(start + text.length, start + text.length);
  fireEvent.input(input, { data: text, inputType: 'insertText' });
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
    expect(renderField({ value: 90 * 60 }).input.value).toBe('90 minutes');
  });

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

  it('switches the unit when shorthand is typed after an amount', () => {
    const { input, onChange } = renderField({ value: null });

    input.focus();
    type(input, '1');
    expect(input.value).toBe('1 hour');

    editAtSelection(input, '1d hour', 1, 1, 2);

    expect(onChange).toHaveBeenLastCalledWith(86400);
    expect(input.value).toBe('1 day');
    expect(input.selectionStart).toBe(1);
    expect(document.activeElement).toBe(input);
  });

  it('replaces the whole value when insertion starts outside the editable amount', () => {
    const { input, onChange } = renderField({ value: 3600 });

    input.focus();
    input.setSelectionRange(4, 4);
    insertText(input, '2');

    expect(onChange).toHaveBeenLastCalledWith(2 * 3600);
    expect(input.value).toBe('2 hours');
    expect(input.selectionStart).toBe(1);
  });

  it('closes the options after any text insertion', () => {
    const { input } = renderField({ value: 3600 });

    fireEvent.click(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    input.setSelectionRange(1, 1);
    insertText(input, 'd');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('1 day');
  });

  it('selects off when zero is entered', () => {
    const { input, onChange } = renderField({ value: 3600 });

    input.focus();
    type(input, '0');

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(input.value).toBe('Do not capture');
    fireEvent.click(input);
    expect(screen.getByRole('option', { name: 'Do not capture' }).getAttribute('aria-selected')).toBe('true');
  });

  it('reports a window that does not parse or resolves to nothing as invalid', () => {
    const { input, onChange } = renderField({ value: null });

    input.focus();
    for (const text of ['soon', '-1h', '']) {
      type(input, text);
      expect(onChange).toHaveBeenLastCalledWith('invalid');
      expect(document.activeElement).toBe(input);
    }
    expect(screen.getByRole('alert').textContent).toBe(i18n.t('dashboard.apiKeys.retention.invalid'));
  });

  it('keeps the input mounted when an expanded field becomes invalid', () => {
    function Host() {
      const [value, setValue] = useState<RetentionValue>(90 * 60);
      return <RetentionField
        description="How long captured requests are kept"
        icon={null}
        label="Retention"
        offLabel="Do not capture"
        offValue={null}
        presets={DUMP_PRESETS}
        value={value}
        onChange={setValue}
      >
        {typeof value === 'number' ? <span>Captured requests</span> : undefined}
      </RetentionField>;
    }

    renderInApp(<Host />);
    const input = screen.getByRole('combobox') as HTMLInputElement;

    input.focus();
    type(input, 'soon');

    expect(screen.getByRole('combobox')).toBe(input);
    expect(document.activeElement).toBe(input);

    fireEvent.blur(input);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('soon');
  });

  it('keeps valid and invalid edits in the middle under IMask ownership', () => {
    const { input } = renderField({ value: 12 });

    expect(input.getAttribute('value')).toBeNull();
    input.focus();
    editAtSelection(input, '132 seconds', 1, 1, 2);
    expect(input.value).toBe('132 seconds');

    editAtSelection(input, '13x2 seconds', 2, 2, 3);
    expect(input.value).toBe('13x2');
  });

  it('formats explicit units through the same mask when the default unit is days', () => {
    const { input, onChange } = renderField({
      defaultUnit: 'd',
      maximumSeconds: RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      multipleOfSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 0,
    });

    input.focus();
    type(input, '1');
    expect(input.value).toBe('1 day');

    editAtSelection(input, '1s day', 1, 1, 2);
    expect(onChange).toHaveBeenLastCalledWith('invalid');
    expect(input.value).toBe('1 second');
    expect(input.selectionStart).toBe(1);

    type(input, '1d');
    expect(onChange).toHaveBeenLastCalledWith(SECONDS_PER_DAY);
    expect(input.value).toBe('1 day');
    expect(input.selectionStart).toBe(1);
    expect(document.activeElement).toBe(input);
  });

  it('preserves a paste-style replacement in the formatted editable value', () => {
    const { input } = renderField({
      defaultUnit: 'd',
      maximumSeconds: RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      multipleOfSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 123 * SECONDS_PER_DAY,
    });

    input.focus();
    editAtSelection(input, '1453 days', 1, 2, 3);

    expect(input.value).toBe('1453 days');
  });

  it('uses IMask history for undo', () => {
    const { input, onChange } = renderField({ value: null });

    input.focus();
    type(input, '30m');
    type(input, '3d');
    fireEvent.keyDown(input, { ctrlKey: true, key: 'z', keyCode: 90 });

    expect(input.value).toBe('30 minutes');
    expect(onChange).toHaveBeenLastCalledWith(1800);
  });

  it('resets IMask history when an external value replaces the edit', () => {
    function Host() {
      const [value, setValue] = useState<RetentionValue>(null);
      return <>
        <button onClick={() => setValue(6 * 3600)} type="button">Reset retention</button>
        <RetentionField
          description="How long captured requests are kept"
          icon={null}
          label="Retention"
          offLabel="Do not capture"
          offValue={null}
          presets={DUMP_PRESETS}
          value={value}
          onChange={setValue}
        />
      </>;
    }

    renderInApp(<Host />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    type(input, '30m');
    fireEvent.click(screen.getByRole('button', { name: 'Reset retention' }));
    fireEvent.keyDown(input, { ctrlKey: true, key: 'z', keyCode: 90 });

    expect(input.value).toBe('6 hours');
  });

  it('uses days as the configured default unit for a bare number', () => {
    const { input, onChange } = renderField({
      defaultUnit: 'd',
      maximumSeconds: RESPONSES_MAX_SECONDS,
      minimumSeconds: SECONDS_PER_DAY,
      multipleOfSeconds: SECONDS_PER_DAY,
      offValue: 0,
      value: 0,
    });

    type(input, '14');
    expect(onChange).toHaveBeenLastCalledWith(14 * SECONDS_PER_DAY);
    expect(input.value).toBe('14 days');

    type(input, '1');
    expect(onChange).toHaveBeenLastCalledWith(SECONDS_PER_DAY);
  });

  it('enforces the configured range and whole-day granularity', () => {
    const { input, onChange } = renderField({
      defaultUnit: 'd',
      maximumSeconds: RESPONSES_MAX_SECONDS,
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

  it('refuses a null window on a field whose off value is zero', () => {
    expect(() => renderField({ offValue: 0, value: null })).toThrow(TypeError);
  });
});
