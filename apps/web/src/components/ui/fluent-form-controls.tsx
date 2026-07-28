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

const MIN_WIDTH_CLASS = '!min-w-[0px]';

// Fluent lets the popup keep its natural height and flips it to whichever
// side has room for that height, so a long list ends up beside the field
// rather than under it. Restricting the fallbacks to the opposite edge keeps
// the list attached to its control, and `autoSize` then trims it to the space
// that edge actually has instead of moving it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/types.ts#L244-L264
const LISTBOX_POSITIONING: ComponentProps<typeof FluentCombobox>['positioning'] = {
  position: 'below',
  align: 'start',
  autoSize: 'height',
  fallbackPositions: ['above'],
  overflowBoundaryPadding: 8,
};

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
  ({ className, positioning, ...props }, ref) => (
    <FluentCombobox
      {...props}
      positioning={positioning ?? LISTBOX_POSITIONING}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
) as typeof FluentCombobox;

export const Dropdown = forwardRef<HTMLButtonElement, ComponentProps<typeof FluentDropdown>>(
  ({ className, positioning, ...props }, ref) => (
    <FluentDropdown
      {...props}
      positioning={positioning ?? LISTBOX_POSITIONING}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
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
