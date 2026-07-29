import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { fieldHorizontalRootAtom } from '../../src/winui/controls/field.css';
import { winuiLightTheme } from '../../src/winui/theme';

const { Field, FluentProvider, Input } = fluentComponents;

const renderField = (orientation: 'horizontal' | 'vertical') =>
  render(
    <FluentProvider theme={winuiLightTheme}>
      <Field label="label" orientation={orientation}>
        <Input />
      </Field>
    </FluentProvider>,
  ).container.querySelector('.fui-Field');

afterEach(cleanup);

// The WinUI label rule narrows itself to vertical Fields by negating the
// hashed atom Griffel emits for Fluent's horizontal root style. Nothing in
// Fluent's public surface pins that name, so this suite is what stands between
// a Fluent bump that rehashes it and a rule that silently widens to both
// orientations.
describe('field horizontal root atom', () => {
  it('is the class Fluent puts on a horizontal Field and on no other', () => {
    expect(renderField('horizontal')?.classList.contains(fieldHorizontalRootAtom)).toBe(true);
    expect(renderField('vertical')?.classList.contains(fieldHorizontalRootAtom)).toBe(false);
  });
});
