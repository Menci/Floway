import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { ScopeExpression, type ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { setLanguage } from '../../../src/i18n';
import { renderInApp } from '../../render';

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [], accessRecordCount: 0 }],
  groups: [{ id: 3, name: 'operators', createdAt: '', deletedAt: null, memberIds: [2], accessRecordCount: 0 }],
  upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', enabled: true, hue: 210, cachedModelCount: 2 }],
  models: [{ id: 'gpt-5', display_name: 'GPT-5', upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', hue: 210 }] }] as ScopeExpressionData['models'],
};

afterEach(async () => await setLanguage('en'));

test('changing the kind commits the collection scope and drops incompatible later parts', () => {
  const onChange = vi.fn();
  renderInApp(<ScopeExpression data={data} onChange={onChange} value={{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }} />);

  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'u' } });
  fireEvent.click(screen.getByRole('option', { name: 'User' }));

  expect(onChange).toHaveBeenLastCalledWith({ kind: 'users' });
});

test('model suggestions order existing, literal, and regex and store a raw regex pattern', () => {
  const onChange = vi.fn();
  renderInApp(<ScopeExpression data={data} onChange={onChange} value={{ kind: 'upstream', upstreamId: 'up_a' }} />);

  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gp' } });
  const options = screen.getAllByRole('option');
  expect(options.map(option => option.getAttribute('data-value') ?? option.textContent)).toHaveLength(3);
  expect(options[0].textContent).toContain('gpt-5');
  expect(options[1].textContent).toContain('gp');
  expect(options[2].textContent).toContain('/gp/');
  fireEvent.click(options[2]);

  expect(onChange).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });
});

test('resource type autocomplete matches localized labels', async () => {
  await setLanguage('zh-Hans');
  renderInApp(<ScopeExpression data={data} onChange={vi.fn()} value={{ kind: 'upstreams' }} />);

  fireEvent.click(screen.getByRole('button', { name: '上游' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '用户' } });

  expect(screen.getByRole('option', { name: '用户' })).not.toBeNull();
});
