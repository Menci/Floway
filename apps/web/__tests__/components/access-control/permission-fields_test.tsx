import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { PermissionFields } from '../../../src/components/access-control/permission-fields';
import { renderInApp } from '../../render';
import type { AccessValues } from '@floway-dev/gateway/browser';

function Editor() {
  const [values, setValues] = useState<AccessValues>({});
  return <>
    <PermissionFields busy={false} disabled={false} inherited={{ 'Model.Use': true }} onChange={(permission, value) => setValues(current => {
      if (value !== undefined) return { ...current, [permission]: value };
      const next = { ...current };
      delete next[permission];
      return next;
    })} permissions={['Model.Use']} values={values} />
    <output data-testid="values">{JSON.stringify(values)}</output>
  </>;
}
const choose = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

test('concrete radios preserve explicit false and re-click restores the inherited value', () => {
  renderInApp(<Editor />);
  expect(screen.getAllByRole('radio').map(node => node.getAttribute('value'))).toEqual(['off', 'on']);
  expect(screen.queryByRole('button')).toBeNull();
  choose('Off');
  expect(screen.getByTestId('values').textContent).toBe('{"Model.Use":false}');
  choose('Off');
  expect(screen.getByTestId('values').textContent).toBe('{}');
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'On' }).checked).toBe(true);
});

test.each(['click', 'space'])('re-activating a selected option by %s toggles its source', activation => {
  const { container } = renderInApp(<Editor />);
  const marker = () => container.querySelector('[data-inherited-value-icon="branch"]')!;
  for (const source of ['explicit', 'inherited']) {
    const radio = screen.getByRole('radio', { name: 'On' });
    if (activation === 'click') fireEvent.click(radio); else fireEvent.keyDown(radio, { key: ' ', code: 'Space' });
    expect(marker().getAttribute('data-inheritance-active')).toBe(String(source === 'inherited'));
    expect(marker().getAttribute('data-inheritance-glyph')).toBe(source === 'inherited' ? 'filled' : 'regular');
    expect(screen.getByTestId('values').textContent).toBe(source === 'inherited' ? '{}' : '{"Model.Use":true}');
  }
});
