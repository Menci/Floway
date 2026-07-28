import { forwardRef } from 'react';
import type { ComponentProps } from 'react';

import { fluentComponents } from '../../fluent';

const {
  Combobox: FluentCombobox,
  Dropdown: FluentDropdown,
  Input: FluentInput,
  Select: FluentSelect,
  SpinButton: FluentSpinButton,
  Textarea: FluentTextarea,
  mergeClasses,
} = fluentComponents;

// Fluent sizes these controls with a minimum width, and the native `input` and
// `select` they wrap contribute their own `min-width: auto`. That intrinsic
// floor propagates up through every auto-sized grid track above the control, so
// a field in a fluid column can push its whole layout wider than the container.
// Zeroing both the wrapper and the native element lets the column decide.
const MIN_WIDTH_CLASS = '!min-w-[0px] [&_input]:!min-w-[0px] [&_select]:!min-w-[0px]';

export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof FluentInput>>(
  ({ className, ...props }, ref) => (
    <FluentInput {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentInput;

export const Select = forwardRef<HTMLSelectElement, ComponentProps<typeof FluentSelect>>(
  ({ className, ...props }, ref) => (
    <FluentSelect {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentSelect;

export const Combobox = forwardRef<HTMLInputElement, ComponentProps<typeof FluentCombobox>>(
  ({ className, ...props }, ref) => (
    <FluentCombobox {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentCombobox;

export const Dropdown = forwardRef<HTMLButtonElement, ComponentProps<typeof FluentDropdown>>(
  ({ className, ...props }, ref) => (
    <FluentDropdown {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentDropdown;

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof FluentTextarea>>(
  ({ className, ...props }, ref) => (
    <FluentTextarea {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentTextarea;

export const SpinButton = forwardRef<HTMLInputElement, ComponentProps<typeof FluentSpinButton>>(
  ({ className, ...props }, ref) => (
    <FluentSpinButton {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentSpinButton;
