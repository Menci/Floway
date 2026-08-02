import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { fieldSuccessIconAtom } from '../../src/winui/controls/field.css';
import { renderInApp } from '../render';

const { Field, Input } = fluentComponents;

const renderValidationMessageIcon = (validationState: 'success' | 'error' | 'warning') =>
  renderInApp(
    <Field label="label" validationMessage="message" validationState={validationState}>
      <Input />
    </Field>,
  ).container.querySelector('.fui-Field__validationMessageIcon');

// The WinUI rule that colours a success validation message keys on the hashed
// atom Griffel emits for Fluent's success glyph colour, the only DOM trace of a
// state Fluent writes no attribute or role for. The atom hashes property and
// value together, so a Fluent bump that renames the palette token rehashes it
// and the message silently falls back to neutral; this suite is what stands
// between that bump and the lost colour.
describe('field success icon atom', () => {
  it('is the class Fluent puts on a success validation glyph and on no other', () => {
    expect(renderValidationMessageIcon('success')?.classList.contains(fieldSuccessIconAtom)).toBe(
      true,
    );
    expect(renderValidationMessageIcon('error')?.classList.contains(fieldSuccessIconAtom)).toBe(
      false,
    );
    expect(renderValidationMessageIcon('warning')?.classList.contains(fieldSuccessIconAtom)).toBe(
      false,
    );
  });
});
