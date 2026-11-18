import { expect, test } from 'vitest';

import { normalizeFilters } from '../../../src/components/access-control/filters';

const scope = JSON.stringify({ kind: 'upstream', upstreamId: 'a' });

test('removes a malformed principal without changing valid filters', () => {
  const source = new URLSearchParams({ principal: 'garbage', scope, q: 'Model.Use', page: '2', effective: 'true' });
  const normalized = normalizeFilters(source);
  expect(normalized.params).toEqual(new URLSearchParams({ scope, q: 'Model.Use' }));
  expect(normalized.principal).toBeNull();
  expect(normalized.scope).toEqual({ kind: 'upstream', upstreamId: 'a' });
  expect(source.get('principal')).toBe('garbage');
});

test('removes a malformed scope without changing valid filters', () => {
  const value = JSON.stringify({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '[' } });
  const normalized = normalizeFilters(new URLSearchParams({ principal: 'user:2', scope: value, q: 'Model.Use', page: '2', effective: 'true' }));
  expect(normalized.params).toEqual(new URLSearchParams({ principal: 'user:2', q: 'Model.Use' }));
  expect(normalized.invalidScope).toBe(true);
  expect(normalized.principal).toEqual({ kind: 'user', id: 2 });
});

test('removes each malformed filter in one normalization and preserves unrelated URL state', () => {
  const normalized = normalizeFilters(new URLSearchParams('principal=bad&scope=bad&page=3&effective=true&q=Audit&other=keep'));
  expect(normalized.params.toString()).toBe('q=Audit&other=keep');
  expect(normalizeFilters(normalized.params).params).toEqual(normalized.params);
});
