import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { ScopeEditor, ScopeExpression, type ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { setLanguage } from '../../../src/i18n';
import { renderInApp } from '../../render';
import type { AccessScope } from '@floway-dev/gateway/browser';

const data: ScopeExpressionData = {
  users: [{ id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null }, groupIds: [] }],
  groups: [{ hue: 120, id: 3, name: 'operators', createdAt: '', deletedAt: null, memberIds: [2] }],
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

const renderEditor = (initial: AccessScope | null = null, purpose: 'scope' | 'filter' = 'scope') => {
  const changed = vi.fn();
  function Editor() {
    const [value, setValue] = useState(initial);
    return <>
      <ScopeEditor data={data} onChange={next => { changed(next); setValue(next); }} purpose={purpose} value={value} />
      <output data-testid="scope">{JSON.stringify(value)}</output>
    </>;
  }
  const rendered = renderInApp(<Editor />);
  return { ...rendered, changed };
};

test('removes one model, upstream and resource-type segment per click', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  for (const expected of [{ kind: 'upstream', upstreamId: 'up_a' }, { kind: 'upstreams' }, null]) {
    fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
    expect(changed).toHaveBeenLastCalledWith(expected);
    expect(screen.queryByRole('combobox')).toBeNull();
  }
  expect(screen.queryByRole('button', { name: 'Remove last scope segment' })).toBeNull();
});

test('read-only mode closes an active draft and cancels its deferred blur', async () => {
  const changed = vi.fn();
  const value = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } } as const;
  const { rerender } = renderInApp(<ScopeEditor data={data} onChange={changed} value={value} />);
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'uncommitted' } });
  fireEvent.blur(input);
  rerender(<ScopeEditor data={data} onChange={changed} readOnly value={value} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'gpt-5' })).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(changed).not.toHaveBeenCalled();
  rerender(<ScopeEditor data={data} onChange={changed} value={value} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' }).value).toBe('gpt-5');
});

test.each(['exact', 'regex'] as const)('navigable %s scopes select prefixes without entering edit mode', kind => {
  const navigate = vi.fn();
  const scope = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind, value: 'gpt-5' } } as const;
  const { container } = renderInApp(<ScopeExpression data={data} onNavigate={navigate} readOnly value={scope} />);
  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  expect(navigate).toHaveBeenLastCalledWith({ kind: 'upstreams' });
  fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
  expect(navigate).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  fireEvent.click(container.querySelectorAll('.floway-scope-expression-slash')[2]!);
  expect(navigate).toHaveBeenLastCalledWith(scope);
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('starts with a slash and an ellipsis button and puts matching resource types first', () => {
  const { container } = renderEditor();

  const root = screen.getByRole('button', { name: 'Resource type' });
  expect(root.classList.contains('floway-scope-expression-append')).toBe(true);
  expect(root.querySelector('svg')).toBeTruthy();
  expect(container.querySelector('.floway-scope-expression-slash')!.textContent).toBe('/');
  expect(screen.queryByText('Select')).toBeNull();
  expect(screen.queryByText('All')).toBeNull();

  fireEvent.click(root);
  const input = screen.getByRole('combobox', { name: 'Resource type' });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Self', 'User', 'Upstream', 'Group']);
  fireEvent.change(input, { target: { value: 'u' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['User', 'Upstream', 'Self', 'Group']);
  fireEvent.change(input, { target: { value: 'Upstream' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Upstream', 'Self', 'User', 'Group']);
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

test('lists matched models, custom entries, then every unmatched model', () => {
  renderEditor({ kind: 'upstream', upstreamId: 'up_a' });
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: '^gpt-5$' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['gpt-5', '^gpt-5$', '/^gpt-5$/', 'gpt-6']);
  fireEvent.change(input, { target: { value: '^future$' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['^future$', '/^future$/', 'gpt-5', 'gpt-6']);
  fireEvent.change(input, { target: { value: '[' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['[', 'gpt-5', 'gpt-6']);
  fireEvent.change(input, { target: { value: '^GPT-5$' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['^GPT-5$', '/^GPT-5$/', 'gpt-5', 'gpt-6']);
});

test('commits a freeform model on blur', async () => {
  const { changed } = renderEditor({ kind: 'upstream', upstreamId: 'up_a' });

  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'future-model' } });
  fireEvent.blur(input);

  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'future-model' } }));
});

test('commits a model synchronously before focus reaches a submit action', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'new-model' } });
  const submit = document.createElement('button');
  submit.type = 'submit';
  fireEvent.blur(input, { relatedTarget: submit });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'new-model' } });
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('does not commit an upstream draft on blur without selecting a real upstream', async () => {
  const { changed } = renderEditor({ kind: 'upstreams' });

  fireEvent.click(screen.getByRole('button', { name: 'Resource' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.change(input, { target: { value: 'up_future' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Copilot', 'vLLM']);
  fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });
  fireEvent.blur(input);

  await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByTestId('scope').textContent).toBe('{"kind":"upstreams"}');
});

test.each([
  { scope: { kind: 'upstream', upstreamId: 'up_removed' } as AccessScope, description: 'Unknown upstream ID "up_removed"' },
  { scope: { kind: 'user', userId: 99 } as AccessScope, description: 'Unknown user ID "99"' },
  { scope: { kind: 'group', groupId: 99 } as AccessScope, description: 'Unknown group ID "99"' },
])('shows a short unknown label and describes the missing resource: $description', async ({ scope, description }) => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={scope} />);
  const unknown = screen.getByText('Unknown');
  expect(container.querySelector('.floway-scope-expression')!.textContent).not.toContain('99');
  expect(container.querySelector('.floway-scope-expression')!.textContent).not.toContain('up_removed');
  fireEvent.focus(unknown.closest('[tabindex]')!);
  expect((await screen.findByRole('tooltip')).textContent).toBe(description);
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

test.each(['^org/model$', String.raw`^org\/model$`])('highlights the regex body independently of display delimiters: %j', pattern => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: pattern } }} />);
  const regex = container.querySelector('.floway-scope-expression-regex')!;
  expect(regex.textContent).toBe(`/${pattern}/`);
  expect(regex.querySelector('.token.regex')).not.toBeNull();
  expect(regex.querySelector('.token.comment')).toBeNull();
  expect(regex.querySelector('.token.anchor')?.textContent).toBe('^');
});

test('resource type autocomplete matches localized labels', async () => {
  await setLanguage('zh-Hans');
  renderEditor({ kind: 'upstreams' });

  fireEvent.click(screen.getByRole('button', { name: '上游' }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '用户' } });

  expect(screen.getByRole('option', { name: '用户' })).not.toBeNull();
});
