import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { ScopeExpression, type ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { setLanguage } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { AccessScope } from '@floway-dev/gateway/browser';

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', groupIds: [], accessRecordCount: 0 }],
  groups: [{ id: 3, name: 'operators', createdAt: '', deletedAt: null, memberIds: [2], accessRecordCount: 0 }],
  upstreams: [
    { id: 'up_a', name: 'Copilot', kind: 'copilot', enabled: true, hue: 210, cachedModelCount: 2 },
    { id: 'up_b', name: 'vLLM', kind: 'custom', enabled: true, hue: 30, cachedModelCount: 0 },
  ],
  models: [
    { id: 'gpt-5', display_name: 'GPT-5', upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', hue: 210 }] },
    { id: 'gpt-6', display_name: 'GPT-6', upstreams: [{ id: 'up_a', name: 'Copilot', kind: 'copilot', hue: 210 }] },
  ] as ScopeExpressionData['models'],
};

afterEach(async () => await setLanguage('en'));

const renderEditor = (initial: AccessScope | null = null) => {
  const changed = vi.fn();
  function Editor() {
    const [value, setValue] = useState(initial);
    return <>
      <ScopeExpression data={data} onChange={next => { changed(next); setValue(next); }} value={value} />
      <output data-testid="scope">{JSON.stringify(value)}</output>
    </>;
  }
  const rendered = renderInApp(<Editor />);
  return { ...rendered, changed };
};

test('starts as only a focusable slash and narrows resource types as the user types', () => {
  renderEditor();

  const root = screen.getByRole('button', { name: 'Resource type' });
  expect(root.textContent).toBe('/');
  expect(screen.queryByText('Select')).toBeNull();
  expect(screen.queryByText('All')).toBeNull();

  fireEvent.focus(root);
  const input = screen.getByRole('combobox', { name: 'Resource type' });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['User', 'Upstream', 'Group']);
  fireEvent.change(input, { target: { value: 'u' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['User', 'Upstream']);
});

test('advances from kind to upstream to model while storing each valid prefix', () => {
  const { changed } = renderEditor();

  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreams' });
  expect(screen.getByRole('combobox', { name: 'Resource' })).toBeTruthy();
  expect(screen.queryByText('All')).toBeNull();

  fireEvent.click(screen.getByRole('option', { name: 'Copilot' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  const model = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(model, { target: { value: 'gp' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['gpt-5', 'gpt-6', 'gp', '/gp/']);

  fireEvent.click(screen.getAllByRole('option').find(option => option.textContent === '/gp/')!);
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });
});

test('changing an upstream preserves the later model even when the new upstream does not list it', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });

  fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.change(input, { target: { value: 'v' } });
  fireEvent.click(screen.getByRole('option', { name: 'vLLM' }));

  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_b', model: { kind: 'exact', value: 'gpt-5' } });
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' }).value).toBe('');
});

test('keeps the current model first until the input becomes dirty, then restores normal candidate order', () => {
  const { container } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });

  fireEvent.click(container.querySelector('.floway-scope-expression-regex')!.closest('button')!);
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['/gp/', 'gpt-5', 'gpt-6', 'gp']);

  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'g' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['gpt-5', 'gpt-6', 'g', '/g/']);
});

test('commits a freeform model on blur', async () => {
  const { changed } = renderEditor({ kind: 'upstream', upstreamId: 'up_a' });

  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'future-model' } });
  fireEvent.blur(input);

  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'future-model' } }));
});

test('commits a freeform upstream on blur', async () => {
  const { changed } = renderEditor({ kind: 'upstreams' });

  fireEvent.click(screen.getByRole('button', { name: 'Resource' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.change(input, { target: { value: 'up_future' } });
  fireEvent.blur(input);

  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_future' }));
});

test('changing the resource type deletes incompatible later parts', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });

  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Resource type' }), { target: { value: 'User' } });
  fireEvent.click(screen.getByRole('option', { name: 'User' }));

  expect(changed).toHaveBeenLastCalledWith({ kind: 'users' });
  expect(screen.queryByText('Copilot')).toBeNull();
  expect(screen.queryByText('gpt-5')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Resource' })).toBeTruthy();
});

test('discards the active draft when another part is clicked', async () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });

  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const model = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(model, { target: { value: 'discard-me' } });
  const kind = screen.getByRole('button', { name: 'Upstream' });
  fireEvent.pointerDown(kind);
  fireEvent.blur(model, { relatedTarget: kind });
  fireEvent.click(kind);

  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' }).value).toBe('Upstream'));
  expect(changed).not.toHaveBeenCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'discard-me' } });
  expect(screen.getByTestId('scope').textContent).toBe('{"kind":"upstreamModel","upstreamId":"up_a","model":{"kind":"exact","value":"gpt-5"}}');
});

test('does not offer or commit literal user ids in the visual editor', async () => {
  const { changed } = renderEditor();

  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  fireEvent.click(screen.getByRole('option', { name: 'User' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.change(input, { target: { value: '999' } });
  expect(screen.queryByRole('option', { name: '999' })).toBeNull();
  fireEvent.blur(input);

  await waitFor(() => expect(screen.getByTestId('scope').textContent).toBe('{"kind":"users"}'));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith({ kind: 'users' });
});

test('read-only collections show their real path without a fabricated All segment', () => {
  renderInApp(<ScopeExpression data={data} readOnly value={{ kind: 'users' }} />);

  expect(screen.getByText('User')).toBeTruthy();
  expect(screen.queryByText('All')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('renders stored regex patterns with delimiters, a regex icon, and Prism markup', () => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-[56]' } }} />);

  const regex = container.querySelector('.floway-scope-expression-regex');
  expect(regex?.textContent).toBe('/^gpt-[56]/');
  expect(regex?.querySelector('.token.regex')).not.toBeNull();
  expect(regex?.previousElementSibling?.tagName).toBe('svg');
});

test('resource type autocomplete matches localized labels', async () => {
  await setLanguage('zh-Hans');
  renderEditor({ kind: 'upstreams' });

  fireEvent.click(screen.getByRole('button', { name: '上游' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '用户' } });

  expect(screen.getByRole('option', { name: '用户' })).not.toBeNull();
});
