import { describe, expect, it } from 'vitest';

import { parseHiddenSeries, serializeHiddenSeries } from '../../../src/components/telemetry/hidden-series-url';

describe('hidden series URL state', () => {
  it('round-trips opaque IDs through stable repeated parameters', () => {
    const first = new URLSearchParams();
    const second = new URLSearchParams();
    serializeHiddenSeries(first, 'hide', ['模型', 'duplicate', '100%', 'a,b', 'duplicate']);
    serializeHiddenSeries(second, 'hide', ['duplicate', 'a,b', '模型', '100%', 'duplicate']);

    expect(first.toString()).toBe(second.toString());
    expect(first.get('hidev')).toBe('2');
    expect(first.getAll('hide')).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
    expect(parseHiddenSeries(first, 'hide')).toEqual(['100%', 'a,b', 'duplicate', 'duplicate', '模型']);
  });

  it('restores legacy comma-separated bookmarks', () => {
    expect(parseHiddenSeries(new URLSearchParams('hide=a%252Cb,c'), 'hide')).toEqual(['a,b', 'c']);
  });

  it('treats an incomplete legacy percent escape as an opaque ID', () => {
    expect(parseHiddenSeries(new URLSearchParams('hide=100%25'), 'hide')).toEqual(['100%']);
  });
});
