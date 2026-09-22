import type InputMask from 'imask/esm/controls/input';
import IMask from 'imask/esm/imask';
import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

import { MaskedRetention, type DurationUnit, type FormatDuration, type MaskedRetentionOptions, type MaskedRetentionValue } from './retention-mask';
import { fluentComponents } from '../../fluent';
import { Combobox, LISTBOX_POSITIONING } from '../ui/fluent-form-controls';

const { Option } = fluentComponents;

export interface RetentionPreset {
  readonly seconds: number;
}

export type RetentionComboboxValue = number | 'off' | 'invalid';

type RetentionInputMask = InputMask<{ mask: MaskedRetention }>;
type Choice = 'off' | 'custom' | `seconds:${number}`;

interface EditorState {
  choice: Choice;
  custom: string;
  externalValue: RetentionComboboxValue;
  publishedValue: RetentionComboboxValue | null;
  value: RetentionComboboxValue;
}

const choiceFor = (value: RetentionComboboxValue, presets: readonly RetentionPreset[]): Choice => {
  if (value === 'invalid') return 'custom';
  if (value === 'off') return 'off';
  return presets.some(preset => preset.seconds === value) ? `seconds:${value}` : 'custom';
};

const editorStateFor = (
  value: RetentionComboboxValue,
  presets: readonly RetentionPreset[],
  displayValue: string,
): EditorState => ({
  value,
  choice: choiceFor(value, presets),
  custom: displayValue,
  externalValue: value,
  publishedValue: null,
});

// IMask owns the text and selection while Fluent owns the options and popup.
// Keeping that bridge here gives every retention field the same editing model.
export function RetentionCombobox({
  ariaDescribedBy,
  defaultUnit,
  disabled,
  formatDuration,
  formatSeconds,
  invalid,
  label,
  offLabel,
  onBlur,
  onChange,
  onFocus,
  placeholder,
  presets,
  value,
}: {
  ariaDescribedBy?: string;
  defaultUnit: DurationUnit;
  disabled: boolean;
  formatDuration: FormatDuration;
  formatSeconds: (seconds: number) => string;
  invalid: boolean;
  label: string;
  offLabel: string;
  onBlur: () => void;
  onChange: (value: MaskedRetentionValue) => RetentionComboboxValue;
  onFocus: () => void;
  placeholder: string;
  presets: readonly RetentionPreset[];
  value: RetentionComboboxValue;
}) {
  const valueDisplay = value === 'off' ? offLabel : typeof value === 'number' ? formatSeconds(value) : '';
  const [editor, setEditor] = useState(() => editorStateFor(value, presets, valueDisplay));
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const inputMask = useRef<RetentionInputMask | null>(null);
  const synchronizingMask = useRef(false);

  if (editor.externalValue !== value) {
    setEditor(editor.publishedValue === value
      ? { ...editor, externalValue: value, publishedValue: null }
      : editorStateFor(value, presets, valueDisplay));
  }

  const publishMask = (mask: RetentionInputMask, notify: boolean) => {
    const masked = mask.typedValue;
    const next = notify ? onChange(masked) : value;
    setEditor(current => ({
      ...current,
      value: next,
      choice: choiceFor(next, presets),
      custom: mask.displayValue,
      publishedValue: notify ? next : current.publishedValue,
    }));
  };

  const acceptMaskedValue = useEffectEvent((mask: RetentionInputMask) => {
    setOpen(false);
    if (!synchronizingMask.current) publishMask(mask, true);
  });
  const publishExternalMask = useEffectEvent((mask: RetentionInputMask) => publishMask(mask, false));

  useLayoutEffect(() => {
    if (input === null) return;
    const model = new MaskedRetention({ defaultUnit, formatDuration, offLabel });
    const mask = IMask(input, { mask: model });
    const accept = () => acceptMaskedValue(mask);
    const prepareInsertion = (event: InputEvent) => {
      if (!event.inputType.startsWith('insert')) return;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      if (!mask.masked.isSelectionEditable(start, end)) {
        input.setSelectionRange(0, input.value.length);
      }
      // Paste and composition can reach beforeinput without a keydown, so the
      // normalized selection must become IMask's diff baseline here as well.
      mask._saveSelection();
    };
    const closeAfterInput = () => setOpen(false);
    inputMask.current = mask;
    input.addEventListener('beforeinput', prepareInsertion, true);
    input.addEventListener('input', closeAfterInput);
    mask.on('accept', accept);
    return () => {
      input.removeEventListener('beforeinput', prepareInsertion, true);
      input.removeEventListener('input', closeAfterInput);
      mask.off('accept', accept);
      mask.destroy();
      if (inputMask.current === mask) inputMask.current = null;
    };
  }, [defaultUnit, formatDuration, input, offLabel]);

  useLayoutEffect(() => {
    const mask = inputMask.current;
    if (mask === null || editor.publishedValue !== null) return;
    synchronizingMask.current = true;
    try {
      mask.updateOptions({ defaultUnit, formatDuration, offLabel } satisfies Partial<MaskedRetentionOptions>);
      if (value === 'invalid') {
        if (mask.displayValue !== editor.custom) {
          mask.value = editor.custom;
          mask.history.clear();
          mask.updateControl();
        }
      } else if (mask.typedValue !== value) {
        mask.typedValue = value;
        mask.history.clear();
        mask.updateControl();
      }
      publishExternalMask(mask);
    } finally {
      synchronizingMask.current = false;
    }
  }, [defaultUnit, editor.custom, editor.publishedValue, formatDuration, input, offLabel, value]);

  const selectChoice = (choice: Exclude<Choice, 'custom'>) => {
    const mask = inputMask.current;
    if (mask === null) throw new Error('Retention option selected before its input mask mounted');
    setOpen(false);
    mask.typedValue = choice === 'off' ? 'off' : Number(choice.slice('seconds:'.length));
  };

  return <Combobox
    aria-describedby={ariaDescribedBy}
    aria-invalid={invalid || undefined}
    aria-label={label}
    className="!w-auto flex-none"
    disabled={disabled}
    freeform
    // An input has no intrinsic content width, so the character count sizes the
    // row. Fluent's input slot removes its controlled value before IMask takes
    // ownership of DOM value, selection diff, composition and undo history.
    // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useCombobox.tsx#L43-L74
    // https://github.com/uNmAnNeR/imaskjs/blob/a02a14b642f70b335e24789e8a187857473a21a5/packages/imask/src/controls/input.ts#L322-L360
    input={{ size: editor.custom.length + 1, value: undefined }}
    listWidth="content"
    onBlur={onBlur}
    onFocus={onFocus}
    onOpenChange={(_, data) => setOpen(data.open)}
    onOptionSelect={(_, data) => data.optionValue !== undefined && selectChoice(data.optionValue as Exclude<Choice, 'custom'>)}
    open={open}
    placeholder={placeholder}
    positioning={{ ...LISTBOX_POSITIONING, align: 'end' }}
    selectedOptions={editor.choice === 'custom' ? [] : [editor.choice]}
    ref={setInput}
    value={editor.custom}
  >
    <Option value="off">{offLabel}</Option>
    {presets.map(preset => <Option key={preset.seconds} value={`seconds:${preset.seconds}`}>{formatSeconds(preset.seconds)}</Option>)}
  </Combobox>;
}
