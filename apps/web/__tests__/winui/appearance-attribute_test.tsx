import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { winuiCheckedAttribute } from '../../src/winui/appearance';
import { renderInApp } from '../render';

const { Checkbox } = fluentComponents;

describe('the checked axis the WinUI rules read', () => {
  // The WinUI mixed rules cannot read :indeterminate, because the browser clears
  // that property when the user activates the box and Fluent re-asserts it only
  // from an effect keyed on the mixed flag -- which does not re-run while the box
  // stays mixed. Clearing the property here is the activation behavior a real
  // engine performs and happy-dom does not; the stamp has to outlive it.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L163-L169
  // https://html.spec.whatwg.org/multipage/input.html#the-input-element:legacy-pre-activation-behavior
  it('keeps a check box held at mixed stamped across a click', () => {
    const view = renderInApp(<Checkbox checked="mixed" label="mixed" />);

    const input = view.container.querySelector('input')!;

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('mixed');

    input.indeterminate = false;
    fireEvent.click(input);

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('mixed');
    expect(input.indeterminate).toBe(false);
  });

  it('follows an uncontrolled check box onto the state its own change reported', () => {
    const view = renderInApp(<Checkbox defaultChecked label="uncontrolled" />);

    const input = view.container.querySelector('input')!;

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('true');

    fireEvent.click(input);

    expect(input.getAttribute(winuiCheckedAttribute)).toBe('false');
  });
});
