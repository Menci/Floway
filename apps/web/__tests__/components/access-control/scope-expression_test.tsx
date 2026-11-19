import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { ScopeEditor, type ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
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

test('removes one model, upstream and resource-type segment per click while focusing the previous segment', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });

  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  const instanceInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource' });
  expect(instanceInput.value).toBe('Copilot');
  expect(document.activeElement).toBe(instanceInput);

  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreams' });
  const kindInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' });
  expect(kindInput.value).toBe('Upstream');
  expect(document.activeElement).toBe(kindInput);

  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(changed).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove last scope segment' })).toBeNull();
});

test('removing an active draft segment discards only that segment without committing it on blur', () => {
  const { changed } = renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream' }));
  fireEvent.click(screen.getByRole('option', { name: 'Copilot' }));

  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'draft-model' } });
  const remove = screen.getByRole('button', { name: 'Remove last scope segment' });
  expect(fireEvent.mouseDown(remove)).toBe(false);
  fireEvent.click(remove);

  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  const instanceInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource' });
  expect(instanceInput.value).toBe('Copilot');
  expect(document.activeElement).toBe(instanceInput);
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

test('preserves the existing regex kind when a model draft loses focus', async () => {
  const { changed, container } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-' } });

  fireEvent.click(container.querySelector('.floway-scope-expression-regex')!.closest('button')!);
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: '^future-' } });
  fireEvent.blur(input);

  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^future-' } }));
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

test('Backspace on an empty segment discards it and returns to the previous segment with its value intact', async () => {
  const { changed } = renderEditor();

  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream' }));
  fireEvent.click(screen.getByRole('option', { name: 'Copilot' }));
  const modelInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' });

  fireEvent.keyDown(modelInput, { key: 'Backspace' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  const instanceInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource' });
  expect(instanceInput.value).toBe('Copilot');
  expect(document.activeElement).toBe(instanceInput);

  // A blur fired from the unmounted model input must not close the newly focused instance input.
  fireEvent.blur(modelInput);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole('combobox', { name: 'Resource' })).toBe(instanceInput);

  fireEvent.change(instanceInput, { target: { value: '' } });
  fireEvent.keyDown(instanceInput, { key: 'Backspace' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreams' });
  const kindInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' });
  expect(kindInput.value).toBe('Upstream');

  fireEvent.change(kindInput, { target: { value: '' } });
  fireEvent.keyDown(kindInput, { key: 'Backspace' });
  expect(changed).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' }).value).toBe('');
});

test('Backspace keeps a segment whose text is not empty or is still composing', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' });

  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBe(input);

  fireEvent.change(input, { target: { value: '' } });
  fireEvent.keyDown(input, { key: 'Backspace', isComposing: true });
  expect(changed).not.toHaveBeenCalled();
});

test('Backspace on an empty append trigger discards it and focuses the previous segment', () => {
  const { changed } = renderEditor({ kind: 'upstreams' });
  const append = screen.getByRole('button', { name: 'Resource' });
  append.focus();
  fireEvent.keyDown(append, { key: 'Backspace' });
  expect(changed).not.toHaveBeenCalled();
  const kindInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' });
  expect(kindInput.value).toBe('Upstream');
  expect(document.activeElement).toBe(kindInput);
});

test('hides trailing append triggers while editing an earlier segment and restores them after closing', () => {
  renderEditor({ kind: 'upstreams' });
  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  const kindInput = screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource type' });
  expect(screen.queryByRole('button', { name: 'Resource' })).toBeNull();
  fireEvent.keyDown(kindInput, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Resource' })).toBeTruthy();
});

test('hides the trailing model append trigger while editing the upstream segment', () => {
  renderEditor({ kind: 'upstream', upstreamId: 'up_a' });
  fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
  expect(screen.queryByRole('button', { name: 'Model' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Resource' }), { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy();
});

test('Enter selects the top matching candidate', () => {
  const { changed } = renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  const kindInput = screen.getByRole('combobox', { name: 'Resource type' });
  fireEvent.change(kindInput, { target: { value: 'up' } });
  fireEvent.keyDown(kindInput, { key: 'Enter' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreams' });
});

test('blur commits the same top matching candidate as Enter for edited resource segments', async () => {
  const { changed } = renderEditor({ kind: 'upstream', upstreamId: 'up_a' });

  fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.change(input, { target: { value: 'v' } });
  fireEvent.blur(input);

  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_b' }));
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('Enter keeps an unknown resource intact when no real option matches its ID', () => {
  const { changed } = renderEditor({ kind: 'upstream', upstreamId: 'up_removed' });
  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Resource' }), { key: 'Enter' });
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByTestId('scope').textContent).toBe('{"kind":"upstream","upstreamId":"up_removed"}');
});

test('editing a custom literal model keeps that literal first so Enter keeps it', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gp' } });
  fireEvent.click(screen.getByRole('button', { name: 'gp' }));
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'Enter' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gp' } });
});

test('editing an existing regex model puts the regex candidate first so Enter keeps it', () => {
  const { changed, container } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });
  fireEvent.click(container.querySelector('.floway-scope-expression-regex')!.closest('button')!);
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'Enter' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });
});

test('Enter respects keyboard arrow navigation when choosing a lower candidate', () => {
  const { changed } = renderEditor({ kind: 'upstreams' });
  fireEvent.click(screen.getByRole('button', { name: 'Resource' }));
  const input = screen.getByRole('combobox', { name: 'Resource' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_b' });
});
