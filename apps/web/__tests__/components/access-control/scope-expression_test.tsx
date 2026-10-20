import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { ScopeEditor, ScopeExpression, type ScopeExpressionData } from '../../../src/components/access-control/scope-expression';
import { setLanguage } from '../../../src/i18n';
import { scopeExpressionCss } from '../../../src/winui/controls/scope-expression.css';
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

test.each(['exact', 'regex'] as const)('uses standard resource badges and the shared monospace ramp for %s scopes', kind => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind, value: 'gpt-5' } }} />);
  expect(getComputedStyle(container.querySelector('.fui-Tag')!).height).toBe('24px');
  expect(container.querySelector('.font-mono')).toBeTruthy();
  expect(container.querySelector('.mono-size-xs')).toBeNull();
  expect(container.querySelector('.floway-scope-expression-model-icon')).toBeTruthy();
  const segments = [...container.querySelectorAll('.floway-scope-expression-segment')];
  expect(segments).toHaveLength(3);
  expect(segments.map(segment => segment.getAttribute('data-scope-part'))).toEqual(['kind', 'instance', 'model']);
  expect(segments.every(segment => segment.firstElementChild!.classList.contains('floway-scope-expression-slash'))).toBe(true);
  expect(segments.every(segment => segment.childElementCount === 2)).toBe(true);
});

test.each(['exact', 'regex'] as const)('anchors long %s text to its first line and removal to the last', kind => {
  const stylesheet = document.createElement('style');
  stylesheet.textContent = scopeExpressionCss;
  document.head.append(stylesheet);
  try {
    const value: AccessScope = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind, value: `^claude-(sonnet|opus)-${'1'.repeat(240)}` } };
    const { container } = renderInApp(<>
      <ScopeEditor data={data} value={value} />
      <ScopeExpression data={data} readOnly value={value} />
      <ScopeEditor data={data} value={{ kind: 'upstream', upstreamId: 'up_a' }} />
    </>);
    const segments = container.querySelectorAll('.floway-scope-expression-segment:has(.floway-scope-expression-model-icon)');
    expect(segments).toHaveLength(2);
    for (const segment of container.querySelectorAll('.floway-scope-expression-segment:not([data-scope-part="model"])')) {
      expect(getComputedStyle(segment.querySelector('.floway-scope-expression-part')!).alignItems).toBe('center');
    }
    for (const slash of container.querySelectorAll('.floway-scope-expression-slash')) {
      expect(slash.firstElementChild!.classList.contains('floway-control-label')).toBe(true);
    }
    for (const segment of segments) {
      const part = segment.querySelector('.floway-scope-expression-part')!;
      expect(getComputedStyle(segment).alignItems).toBe('flex-start');
      expect(getComputedStyle(part).alignItems).toBe('flex-start');
      expect(getComputedStyle(part).textAlign).toBe('start');
    }
    expect(screen.getAllByRole('button', { name: 'Remove last scope segment' }).every(button => getComputedStyle(button).alignSelf === 'flex-end')).toBe(true);
    fireEvent.click(segments[0]!.querySelector('button')!);
    expect(getComputedStyle(container.querySelector('.floway-scope-expression-part-control')!).alignItems).toBe('flex-start');
    const options = screen.getAllByRole('option').map(option => option.querySelector('.floway-scope-expression-option')!);
    expect(options.every(option => getComputedStyle(option).alignItems === 'flex-start')).toBe(true);
    expect(options.every(option => getComputedStyle(option).overflowWrap === 'anywhere')).toBe(true);
    const resourceEditor = container.querySelectorAll('.floway-scope-editor')[1]!;
    fireEvent.click(resourceEditor.querySelector('.floway-scope-expression-segment:nth-child(2) button')!);
    expect(getComputedStyle(resourceEditor.querySelector('.floway-scope-expression-part-control')!).alignItems).toBe('center');
  } finally {
    stylesheet.remove();
  }
});

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

test('uses the field clear icon inside the scope removal button', () => {
  renderEditor({ kind: 'upstream', upstreamId: 'up_a' });
  const icon = screen.getByRole('button', { name: 'Remove last scope segment' }).querySelector('svg')!;
  expect(icon.style.width).toBe('12px');
  expect(icon.style.height).toBe('12px');
  expect(icon.getAttribute('viewBox')).toBe('0 0 12 12');
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

test.each([
  [{ kind: 'user', userId: 2 }, 'alice'],
  [{ kind: 'group', groupId: 3 }, 'operators'],
  [{ kind: 'upstream', upstreamId: 'up_a' }, 'Copilot'],
  [{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, 'gpt-5'],
] as const)('preserves the %s token footprint until its draft changes', (scope, label) => {
  const { container } = renderEditor(scope);
  fireEvent.click(screen.getByRole('button', { name: label }));
  const part = container.querySelector('.floway-scope-expression-part-editor')!;
  const preview = part.querySelector('.floway-scope-expression-part-preview')!;
  expect(part.getAttribute('data-pristine')).toBe('true');
  expect(preview.textContent).toContain(label);
  expect(preview.getAttribute('aria-hidden')).toBe('true');
  expect(preview.hasAttribute('inert')).toBe(true);
  expect(preview.querySelector('input, button')).toBeNull();
  expect(screen.getAllByRole('combobox')).toHaveLength(1);

  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'draft' } });
  expect(part.hasAttribute('data-pristine')).toBe(false);
  expect(part.querySelector('.floway-scope-expression-part-preview')).toBeNull();
});

test('removing a group keeps the Group prefix', () => {
  const { changed } = renderEditor({ kind: 'group', groupId: 3 });
  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'groups' });
  expect(screen.getByRole('button', { name: 'Group' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resource' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(screen.queryByRole('button', { name: 'Group' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove last scope segment' })).toBeNull();
});

test('removing the last segment while editing discards its draft', () => {
  const { changed } = renderEditor({ kind: 'user', userId: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'alice' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Resource' }), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove last scope segment' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'users' });
  expect(screen.queryByRole('combobox')).toBeNull();
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

test.each([
  [null, 'Resource type', ''],
  [{ kind: 'upstreams' }, 'Resource', ''],
  [{ kind: 'upstream', upstreamId: 'up_a' }, 'Model', ''],
  [{ kind: 'user', userId: 2 }, 'Resource', 'alice'],
  [{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, 'Model', 'gpt-5'],
] as const)('clicking editor whitespace activates the last segment for %j', (scope, label, value) => {
  const { container } = renderEditor(scope);
  fireEvent.click(container.querySelector('.floway-scope-editor')!);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: label });
  expect(input.value).toBe(value);
  expect(document.activeElement).toBe(input);
});

test.each([0, 1, 2])('clicking slash text %i edits its following segment', index => {
  const { container } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(container.querySelectorAll('.floway-scope-expression-slash')[index]!.firstElementChild!);
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: ['Resource type', 'Resource', 'Model'][index] }).value).toBe(['Upstream', 'Copilot', 'gpt-5'][index]);
});

test('clicking the slash of an active segment preserves and focuses its draft', () => {
  const { container, changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(container.querySelector('.floway-scope-editor')!);
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'draft-model' } });
  fireEvent.mouseDown(container.querySelectorAll('.floway-scope-expression-slash')[2]!);
  fireEvent.click(container.querySelectorAll('.floway-scope-expression-slash')[2]!);
  expect(input.value).toBe('draft-model');
  expect(document.activeElement).toBe(input);
  expect(changed).not.toHaveBeenCalled();
});

test('clicking trailing editor whitespace preserves and focuses the current final draft', () => {
  const { container, changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'draft-model' } });
  fireEvent.click(container.querySelector('.floway-scope-editor')!);
  expect(screen.getByRole('combobox')).toBe(input);
  expect(input.value).toBe('draft-model');
  expect(document.activeElement).toBe(input);
  expect(changed).not.toHaveBeenCalled();
});

test.each(['Upstream', 'Copilot', 'gpt-5'])('Escape immediately returns focus to the %s trigger', label => {
  renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: label }));
});

test.each([
  [null, 'Resource type'],
  [{ kind: 'upstreams' }, 'Resource'],
  [{ kind: 'upstream', upstreamId: 'up_removed' }, 'Unknown'],
] as const)('Escape restores focus to append or unknown triggers for %j', (scope, label) => {
  renderEditor(scope);
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: label }));
});

test('Escape during IME composition keeps the active draft open', () => {
  renderEditor({ kind: 'upstreams' });
  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  const input = screen.getByRole('combobox');
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
  expect(screen.getByRole('combobox')).toBe(input);
});

test('a disabled scope surface and its slash never activate editing', () => {
  const { container } = renderInApp(<ScopeEditor data={data} readOnly value={{ kind: 'upstreams' }} />);
  fireEvent.click(container.querySelector('.floway-scope-editor')!);
  fireEvent.click(container.querySelector('.floway-scope-expression-slash')!);
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

test('selecting Self commits a one-segment scope', () => {
  renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Resource type' }));
  fireEvent.click(screen.getByRole('option', { name: 'Self' }));
  expect(screen.getByTestId('scope').textContent).toBe('{"kind":"self"}');
  expect(screen.getByRole('button', { name: 'Self' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resource' })).toBeNull();
});

test('the read-only root has only a slash and no append button', () => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={null} />);
  expect(container.querySelector('.floway-scope-expression')!.textContent).toBe('/');
  expect(screen.queryByRole('button')).toBeNull();
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

test('scope filters can move back to either parent without retaining a model restriction', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, 'filter');
  fireEvent.click(screen.getByRole('button', { name: 'Copilot' }));
  expect(screen.getAllByRole('option', { name: 'Copilot' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('option', { name: 'Copilot' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_a' });
  fireEvent.click(screen.getByRole('button', { name: 'Upstream' }));
  fireEvent.click(screen.getByRole('option', { name: 'Upstream' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstreams' });
});

test.each(['scope', 'filter'] as const)('offers exact and regex candidates in the %s editor', purpose => {
  renderEditor({ kind: 'upstream', upstreamId: 'up_a' }, purpose);
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'gp' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['gpt-5', 'gpt-6', 'gp', '/gp/']);
});

test('append buttons show ellipses only when another path segment is available', () => {
  const { container } = renderEditor({ kind: 'upstreams' });
  const append = screen.getByRole('button', { name: 'Resource' });
  expect(append.classList.contains('floway-scope-expression-append')).toBe(true);
  expect(append.querySelector('svg')).toBeTruthy();
  expect(container.querySelectorAll('.floway-scope-expression-append')).toHaveLength(1);
  fireEvent.click(append);
  expect(screen.getByRole('combobox', { name: 'Resource' })).toBeTruthy();
  expect(container.querySelector('.fui-Combobox__expandIcon')).toBeNull();
});

test.each(['user', 'group', 'upstreamModel'] as const)('complete %s paths have no append button', kind => {
  const scope: AccessScope = kind === 'user' ? { kind, userId: 2 } : kind === 'group' ? { kind, groupId: 3 }
    : { kind, upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } };
  const { container } = renderEditor(scope);
  expect(container.querySelector('.floway-scope-expression-append')).toBeNull();
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

test('keeps unmatched real upstreams after matching upstreams without inventing a candidate', () => {
  renderEditor({ kind: 'upstreams' });
  fireEvent.click(screen.getByRole('button', { name: 'Resource' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Resource' }), { target: { value: 'v' } });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['vLLM', 'Copilot']);
});

test('Escape discards the draft without committing a freeform model', () => {
  const { changed } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } });
  fireEvent.click(screen.getByRole('button', { name: 'gpt-5' }));
  const input = screen.getByRole('combobox', { name: 'Model' });
  fireEvent.change(input, { target: { value: 'discard-me' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('button', { name: 'gpt-5' })).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
});

test('keeps an existing regex behind matching models even before the input changes', () => {
  const { container } = renderEditor({ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: 'gp' } });

  fireEvent.click(container.querySelector('.floway-scope-expression-regex')!.closest('button')!);
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['gpt-5', 'gpt-6', 'gp', '/gp/']);

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

test('editing an unknown upstream searches its ID but offers only real upstreams', () => {
  const { changed } = renderEditor({ kind: 'upstream', upstreamId: 'up_removed' });
  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Resource' }).value).toBe('up_removed');
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Copilot', 'vLLM']);
  fireEvent.click(screen.getByRole('option', { name: 'vLLM' }));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'upstream', upstreamId: 'up_b' });
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

test('renders stored regex patterns with delimiters, an icon, and internal syntax highlighting', () => {
  const { container } = renderInApp(<ScopeExpression data={data} readOnly value={{ kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-[56]+' } }} />);

  const regex = container.querySelector('.floway-scope-expression-regex');
  expect(regex?.textContent).toBe('/^gpt-[56]+/');
  expect(regex?.querySelector('.token.regex')).not.toBeNull();
  expect(regex?.querySelector('.token.anchor')?.textContent).toBe('^');
  expect(regex?.querySelector('.token.char-class')?.textContent).toBe('[56]');
  expect(regex?.querySelector('.token.quantifier')?.textContent).toBe('+');
  expect(regex?.previousElementSibling?.tagName).toBe('svg');
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
