import { expect, test } from 'vitest';

import { normalizeFilters } from '../../../src/components/access-control/filters';
import { parsePrincipal } from '../../../src/components/access-control/principals';

const scope = JSON.stringify({ kind: 'upstream', upstreamId: 'a' });

test.each(['garbage', '', 'user:0', 'user:-1', 'user:1:extra', 'user:1.5', 'user:1e2', 'group:01', 'group:9007199254740992'])('removes malformed principal %j without changing valid filters', value => {
  const source = new URLSearchParams({ principal: value, scope, q: 'Model.Use', page: '2', effective: 'true' });
  const normalized = normalizeFilters(source);
  expect(normalized.params).toEqual(new URLSearchParams({ scope, q: 'Model.Use' }));
  expect(normalized.principal).toBeNull();
  expect(normalized.scope).toEqual({ kind: 'upstream', upstreamId: 'a' });
  expect(source.get('principal')).toBe(value);
});

test.each(['', 'not-json', 'null', '{}', JSON.stringify({ kind: 'user', userId: 0 }), JSON.stringify({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '[' } })])('removes malformed scope %j without changing valid filters', value => {
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

const validFilters: Record<string, string>[] = [
  { principal: 'group:999', scope: JSON.stringify({ kind: 'upstream', upstreamId: 'deleted' }), effective: 'true' },
  { principal: 'user:2', scope: JSON.stringify({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'unlisted-model' } }) },
  { principal: 'user:2', scope: JSON.stringify({ kind: 'groups' }) },
  { principal: 'user:2' },
  {},
];
test.each(validFilters)('preserves valid IDs, model names and editor prefixes: %j', values => {
  const source = new URLSearchParams(values);
  const normalized = normalizeFilters(source);
  expect(normalized.params).toEqual(source);
  expect(normalized.invalidScope).toBe(false);
});

test('recognizes canonical principal keys', () => {
  expect(parsePrincipal('user:2')).toEqual({ kind: 'user', id: 2 });
  expect(parsePrincipal('group:42')).toEqual({ kind: 'group', id: 42 });
});
