import type { FieldProps } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { fieldHorizontalRootAtom, fieldSuccessIconAtom } from '../../src/winui/controls/field.css';
import { renderInApp } from '../render';

const { Field, Input } = fluentComponents;

const renderField = (props: Partial<FieldProps>, selector: string) =>
  renderInApp(
    <Field label="label" {...props}>
      <Input />
    </Field>,
  ).container.querySelector(selector);

// The WinUI Field rules key on hashed atoms Griffel emits for Fluent's own
// styles, because the states they select are not otherwise in the DOM: the
// orientation rule negates the horizontal root atom, and the success-message
// rule matches the glyph colour atom, the only trace of a state Fluent writes
// no attribute or role for. Nothing in Fluent's public surface pins those
// names, and an atom hashes property and value together, so a Fluent bump that
// renames a palette token rehashes it and the rule silently stops matching.
// This suite is what stands between such a bump and the lost styling.
describe('the Field atoms the WinUI layer pins', () => {
  it('carries the horizontal root atom on a horizontal Field and on no other', () => {
    const rootAtomOf = (orientation: 'horizontal' | 'vertical') =>
      renderField({ orientation }, '.fui-Field')?.classList.contains(fieldHorizontalRootAtom);

    expect(rootAtomOf('horizontal')).toBe(true);
    expect(rootAtomOf('vertical')).toBe(false);
  });

  it('carries the success icon atom on a success validation glyph and on no other', () => {
    const iconAtomOf = (validationState: 'success' | 'error' | 'warning') =>
      renderField(
        { validationMessage: 'message', validationState },
        '.fui-Field__validationMessageIcon',
      )?.classList.contains(fieldSuccessIconAtom);

    expect(iconAtomOf('success')).toBe(true);
    expect(iconAtomOf('error')).toBe(false);
    expect(iconAtomOf('warning')).toBe(false);
  });
});
