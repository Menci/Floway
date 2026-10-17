import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { PermissionFields } from '../../../src/components/access-control/permission-fields';
import { renderInApp } from '../../render';
import type { AccessPermission, AccessValues } from '@floway-dev/gateway/browser';

function Editor({ inherited = { 'Model.Use': true }, known = true, permission = 'Model.Use' }: { inherited?: AccessValues; known?: boolean; permission?: AccessPermission }) {
  const [values, setValues] = useState<AccessValues>({});
  return <>
    <PermissionFields disabled={false} inherited={known ? inherited : undefined} onChange={(permission, value) => setValues(current => {
      if (value !== undefined) return { ...current, [permission]: value };
      const next = { ...current };
      delete next[permission];
      return next;
    })} permissions={[permission]} values={values} />
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

test('all upstream edit levels remain explicit values', () => {
  renderInApp(<Editor inherited={{ 'Upstream.Edit': 'models' }} permission="Upstream.Edit" />);
  for (const [label, value] of [['Full', 'full'], ['Models only', 'models'], ['Off', 'off']]) {
    choose(label);
    expect(screen.getByTestId('values').textContent).toBe(JSON.stringify({ 'Upstream.Edit': value }));
  }
});

test('unknown inheritance leaves all radios unchecked', () => {
  renderInApp(<Editor known={false} />);
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(node => !node.checked)).toBe(true);
  expect(screen.getByText('Inherit (unknown)')).toBeTruthy();
});

test('inherited off is checked without storing an explicit assignment', () => {
  renderInApp(<Editor inherited={{ 'Model.Use': false }} />);
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Off' }).checked).toBe(true);
  expect(screen.getByTestId('values').textContent).toBe('{}');
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

test.each(['.fui-Radio__indicator', '.fui-Radio__label', '[data-inherited-value-icon]'])('the whole inherited option describes its value and source at %s', async selector => {
  const { container } = renderInApp(<Editor />);
  const radio = container.querySelector('[data-inherited-value-icon]')!.closest('.fui-Radio')!;
  fireEvent.pointerOver(radio.querySelector(selector)!);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Inherited value: On (Currently inherited)');
  choose('On');
  expect((await screen.findByRole('tooltip')).textContent).toBe('Inherited value: On (Explicit assignment)');
});

test('inherited titles are secondary regular and explicit titles are primary medium', () => {
  const { container } = renderInApp(<Editor />);
  const title = container.querySelector<HTMLLabelElement>('[data-permission-field] .fui-Label')!;
  expect(title.style.color).toBe('var(--colorNeutralForeground2)');
  expect(title.style.fontWeight).toBe('var(--fontWeightRegular)');
  choose('On');
  expect(title.style.color).toBe('var(--colorNeutralForeground1)');
  expect(title.style.fontWeight).toBe('var(--fontWeightMedium)');
  choose('On');
  expect(title.style.color).toBe('var(--colorNeutralForeground2)');
});
