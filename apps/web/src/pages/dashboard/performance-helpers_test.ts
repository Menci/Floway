import { describe, expect, it } from 'vitest';
import type { LocationQuery } from 'vue-router';

import {
  buildOverviewQuery,
  emptyDisplayRecord,
  emptyOverview,
  parseUrlState,
  serializeUrlState,
  sortRows,
  type GroupBy,
  type UrlState,
} from './performance-helpers.ts';
import type { PerformanceDisplayRecord } from '@floway-dev/gateway/control-plane/performance/aggregate';

// The default state that `parseUrlState({})` produces — sharing it here so
// each round-trip case starts from the same known baseline and only overrides
// the fields under test.
const DEFAULT_STATE: UrlState = {
  metric: 'ttft',
  percentile: 'p95',
  groupBy: 'model',
  range: 'today',
  filterModel: '',
  filterUpstream: '',
  filterOperation: '',
  filterRuntime: '',
  filterUserId: '',
  filterKeyId: '',
  hidden: [],
  sortKey: 'requests',
  sortDir: 'desc',
};

const state = (over: Partial<UrlState> = {}): UrlState => ({ ...DEFAULT_STATE, ...over });

// Minimal record shape — every metric field defaults to null so tests only
// have to name the two or three fields whose values actually matter.
const row = (over: Partial<PerformanceDisplayRecord> & { group: string }): PerformanceDisplayRecord => ({
  bucket: 'b',
  requests: 0,
  errors: 0,
  ttftSamples: 0,
  tpotSamples: 0,
  neutral: 0,
  ttftMsP50: null,
  ttftMsP95: null,
  ttftMsP99: null,
  tpotUsP50: null,
  tpotUsP95: null,
  tpotUsP99: null,
  ...over,
});

const identityResolver = (group: string, _groupBy: GroupBy): string => group;

describe('URL_FIELDS round-trip', () => {
  it('pristine state serializes to `{}` — clean URLs stay clean', () => {
    expect(serializeUrlState(DEFAULT_STATE)).toEqual({});
  });

  it('parseUrlState({}) returns the default state', () => {
    expect(parseUrlState({})).toEqual(DEFAULT_STATE);
  });

  it('serialize then parse round-trips every non-default field', () => {
    const s = state({
      metric: 'tokPerSec',
      percentile: 'p50',
      groupBy: 'upstream',
      range: '7d',
      filterModel: 'gpt-5',
      filterUpstream: 'copilot',
      filterOperation: 'chat',
      filterRuntime: 'sfo',
      filterUserId: '42',
      filterKeyId: 'k-1',
      hidden: ['alpha', 'beta'],
      sortKey: 'ttftMsP95',
      sortDir: 'asc',
    });
    expect(parseUrlState(serializeUrlState(s) as LocationQuery)).toEqual(s);
  });

  it('hidden series with a comma round-trip through encodeURIComponent', () => {
    // The D6 finding: series names may legitimately contain commas
    // (a Copilot upstream id like "openrouter,fallback"). listField
    // percent-encodes each entry so the URL delimiter never collides
    // with a value's own comma.
    const s = state({ hidden: ['a', 'b,c', 'd'] });
    const serialized = serializeUrlState(s);
    expect(serialized.hide).toBe('a,b%2Cc,d');
    expect(parseUrlState(serialized as LocationQuery).hidden).toEqual(['a', 'b,c', 'd']);
  });

  it('enum fields fall back to the default when the URL carries an unknown value', () => {
    const parsed = parseUrlState({
      m: 'nope',
      pct: 'p42',
      g: 'quantumFoam',
      r: 'forever',
      sort: 'wat',
      dir: 'sideways',
    } as LocationQuery);
    expect(parsed.metric).toBe('ttft');
    expect(parsed.percentile).toBe('p95');
    expect(parsed.groupBy).toBe('model');
    expect(parsed.range).toBe('today');
    expect(parsed.sortKey).toBe('requests');
    expect(parsed.sortDir).toBe('desc');
  });

  it('filter_user_id is a bare string field — a non-numeric value survives parse (the backend zod schema is the authority)', () => {
    // We deliberately don't Number()-parse in the SFC; buildOverviewQuery
    // forwards the raw string and the control-plane handler owns coercion.
    const parsed = parseUrlState({ fusr: 'not-a-number' } as LocationQuery);
    expect(parsed.filterUserId).toBe('not-a-number');
    expect(serializeUrlState(parsed).fusr).toBe('not-a-number');
  });

  it('array-valued query params (?m=a&m=b) collapse to the default', () => {
    // vue-router's LocationQuery types allow string[] for repeated keys;
    // asStr rejects arrays so the field silently falls back rather than
    // pretending "first wins" or "join with comma".
    const parsed = parseUrlState({ m: ['tokPerSec', 'ttft'] } as unknown as LocationQuery);
    expect(parsed.metric).toBe('ttft');
  });

  it('empty-string filter is treated as default and elided on serialize', () => {
    // Explicit `fm=` in the URL parses to '' (default), so re-serialize
    // strips the key rather than emitting `?fm=`.
    const parsed = parseUrlState({ fm: '' } as LocationQuery);
    expect(parsed.filterModel).toBe('');
    expect(serializeUrlState(parsed).fm).toBeUndefined();
  });

  it('empty hidden array does not emit a `hide=` param', () => {
    const s = state({ hidden: [] });
    expect(serializeUrlState(s).hide).toBeUndefined();
  });
});

describe('emptyOverview + emptyDisplayRecord', () => {
  it('emptyOverview initializes every axis slot the frontend indexes', () => {
    const o = emptyOverview();
    expect(o.axes.none).toEqual([]);
    expect(o.axes.model).toEqual([]);
    expect(o.axes.upstream).toEqual([]);
    expect(o.axes.runtimeLocation).toEqual([]);
    expect(o.axes.operation).toEqual([]);
    expect(o.axes.keyId).toEqual([]);
    expect(o.axes.userId).toEqual([]);
    expect(o.series).toEqual([]);
    expect(o.users).toEqual([]);
    expect(o.keys).toEqual([]);
    expect(o.dimensionValues).toEqual({
      models: [], upstreams: [], operations: [], runtimeLocations: [], keyIds: [], userIds: [],
    });
  });

  it('emptyDisplayRecord: zero counters + null percentiles across every metric field', () => {
    const r = emptyDisplayRecord('all', 'all');
    expect(r).toEqual({
      bucket: 'all',
      group: 'all',
      requests: 0,
      errors: 0,
      ttftSamples: 0,
      tpotSamples: 0,
      neutral: 0,
      ttftMsP50: null,
      ttftMsP95: null,
      ttftMsP99: null,
      tpotUsP50: null,
      tpotUsP95: null,
      tpotUsP99: null,
    });
  });
});

describe('buildOverviewQuery', () => {
  const fixedNow = Date.UTC(2026, 6, 12, 12, 0, 0);

  it('always emits start/end/bucket/view/group_by/timezone_offset_minutes', () => {
    const q = buildOverviewQuery(state(), 'all-by-user', fixedNow);
    expect(q).toMatchObject({
      view: 'all-by-user',
      group_by: 'model',
      bucket: 'hour',
    });
    expect(typeof q.start).toBe('string');
    expect(typeof q.end).toBe('string');
    expect(typeof q.timezone_offset_minutes).toBe('string');
  });

  it('bucket tracks the range: today=hour, 7d=4h, 30d=day', () => {
    expect(buildOverviewQuery(state({ range: 'today' }), 'self-by-key', fixedNow).bucket).toBe('hour');
    expect(buildOverviewQuery(state({ range: '7d' }), 'self-by-key', fixedNow).bucket).toBe('4h');
    expect(buildOverviewQuery(state({ range: '30d' }), 'self-by-key', fixedNow).bucket).toBe('day');
  });

  it('every empty filter is elided; every non-empty filter reaches the query with its backend key', () => {
    // Empty baseline: none of the filter_* keys appear.
    const empty = buildOverviewQuery(state(), 'all-by-user', fixedNow);
    expect(empty.filter_model).toBeUndefined();
    expect(empty.filter_upstream).toBeUndefined();
    expect(empty.filter_operation).toBeUndefined();
    expect(empty.filter_runtime_location).toBeUndefined();
    expect(empty.filter_user_id).toBeUndefined();
    expect(empty.filter_key_id).toBeUndefined();

    const populated = buildOverviewQuery(state({
      filterModel: 'gpt-5',
      filterUpstream: 'copilot',
      filterOperation: 'chat',
      filterRuntime: 'sfo',
      filterUserId: '42',
      filterKeyId: 'k-1',
    }), 'all-by-user', fixedNow);
    expect(populated.filter_model).toBe('gpt-5');
    expect(populated.filter_upstream).toBe('copilot');
    expect(populated.filter_operation).toBe('chat');
    expect(populated.filter_runtime_location).toBe('sfo');
    expect(populated.filter_user_id).toBe('42');
    expect(populated.filter_key_id).toBe('k-1');
  });
});

describe('sortRows', () => {
  it('numeric column desc: bigger first; nulls last regardless of direction', () => {
    const rows = [
      row({ group: 'a', requests: 10 }),
      row({ group: 'b', requests: 100 }),
      row({ group: 'c', requests: 1 }),
    ];
    const desc = sortRows(rows, 'requests', 'desc', 'model', identityResolver);
    expect(desc.map(r => r.group)).toEqual(['b', 'a', 'c']);
    const asc = sortRows(rows, 'requests', 'asc', 'model', identityResolver);
    expect(asc.map(r => r.group)).toEqual(['c', 'a', 'b']);
  });

  it('numeric column: null values sort last in BOTH directions', () => {
    const rows = [
      row({ group: 'a', ttftMsP95: 100 }),
      row({ group: 'b', ttftMsP95: null }),
      row({ group: 'c', ttftMsP95: 50 }),
    ];
    expect(sortRows(rows, 'ttftMsP95', 'desc', 'model', identityResolver).map(r => r.group)).toEqual(['a', 'c', 'b']);
    expect(sortRows(rows, 'ttftMsP95', 'asc', 'model', identityResolver).map(r => r.group)).toEqual(['c', 'a', 'b']);
  });

  it('tpotUsP95 desc: fastest first (bigger tok/s = smaller tpotUs)', () => {
    // Two rows, 100us (10k tok/s) and 500us (2k tok/s). "Output speed
    // desc" means fastest first per the A2 decision — so 100us leads.
    const rows = [
      row({ group: 'slow', tpotUsP95: 500 }),
      row({ group: 'fast', tpotUsP95: 100 }),
    ];
    expect(sortRows(rows, 'tpotUsP95', 'desc', 'model', identityResolver).map(r => r.group)).toEqual(['fast', 'slow']);
    expect(sortRows(rows, 'tpotUsP95', 'asc', 'model', identityResolver).map(r => r.group)).toEqual(['slow', 'fast']);
  });

  it('ttftMsP95 desc: slowest first (no invert — unlike tpotUsP95)', () => {
    // TTFT is stored ms (smaller = better) but the column stays "TTFT p95".
    // Desc == biggest ms first == slowest first, matching operator intuition
    // when scanning for the worst offenders.
    const rows = [
      row({ group: 'quick', ttftMsP95: 50 }),
      row({ group: 'crawl', ttftMsP95: 800 }),
    ];
    expect(sortRows(rows, 'ttftMsP95', 'desc', 'model', identityResolver).map(r => r.group)).toEqual(['crawl', 'quick']);
  });

  it('group column: applies resolveGroupName exactly once per row (Schwartzian: label cached on the row)', () => {
    let calls = 0;
    const rows = [row({ group: 'z' }), row({ group: 'a' }), row({ group: 'm' })];
    const resolver = (group: string, _groupBy: GroupBy): string => {
      calls++;
      return `label-${group}`;
    };
    const asc = sortRows(rows, 'group', 'asc', 'model', resolver);
    // Three rows in, three calls out — the compare fn reads the cached
    // `groupLabel` field, never the resolver.
    expect(calls).toBe(3);
    expect(asc.map(r => r.groupLabel)).toEqual(['label-a', 'label-m', 'label-z']);
    expect(sortRows(rows, 'group', 'desc', 'model', identityResolver).map(r => r.group)).toEqual(['z', 'm', 'a']);
  });

  it('every row is annotated with resolveGroupName(row.group, groupBy) regardless of sort key', () => {
    // Numeric sorts still project the label — the .vue template reads
    // `row.groupLabel` on every row and never falls back to `row.group`.
    const rows = [row({ group: '7', requests: 5 })];
    const resolver = (group: string, groupBy: GroupBy): string => `${groupBy}:${group}`;
    const [sorted] = sortRows(rows, 'requests', 'desc', 'userId', resolver);
    expect(sorted.groupLabel).toBe('userId:7');
  });
});
