import { describe, expect, it } from 'vitest';

import {
  extractKeySegments,
  stripKeyMarkers,
  withoutUiTextEditorMarkers,
  wrapWithKeyMarkers,
} from '../../../src/i18n/ui-text-editor/markers';

describe('UI text editor markers', () => {
  it('wraps and extracts exact offsets for concatenated strings', () => {
    const first = wrapWithKeyMarkers('Save', 'common.save');
    const second = wrapWithKeyMarkers('Cancel', 'common.cancel');
    const combined = `${first} / ${second}`;

    const extracted = extractKeySegments(combined);
    expect(extracted.hadMarkers).toBe(true);
    expect(extracted.text).toBe('Save / Cancel');
    expect(extracted.segments).toEqual([
      { key: 'common.save', start: 0, end: 4 },
      { key: 'common.cancel', start: 7, end: 13 },
    ]);
  });

  it('tracks nested interpolated translations and orders inner segments first', () => {
    const inner = wrapWithKeyMarkers('Floway', 'app.title');
    const outer = wrapWithKeyMarkers(`Welcome to ${inner}!`, 'welcome.banner');

    const extracted = extractKeySegments(outer);
    expect(extracted.text).toBe('Welcome to Floway!');
    expect(extracted.segments[0]).toEqual({
      key: 'app.title',
      start: 11,
      end: 17,
    });
    expect(extracted.segments[1]).toEqual({
      key: 'welcome.banner',
      start: 0,
      end: 18,
    });
  });

  it('preserves stray ZWJ emoji sequences without mistaking them for markers', () => {
    const emojiText = 'Family: 👨‍👩‍👧‍👦';
    const extracted = extractKeySegments(emojiText);
    expect(extracted.hadMarkers).toBe(false);
    expect(extracted.text).toBe(emojiText);
    expect(stripKeyMarkers(emojiText)).toBe(emojiText);
  });

  it('recovers split <Trans> leading and trailing text nodes', () => {
    const wrapped = wrapWithKeyMarkers('Alias of <strong>3</strong> models', 'alias.count_other');
    const parts = wrapped.split(/<\/?strong>/);
    const leading = extractKeySegments(parts[0]!);
    const trailing = extractKeySegments(parts[2]!);

    expect(leading.text).toBe('Alias of ');
    expect(leading.segments).toEqual([{ key: 'alias.count_other', start: 0, end: 9 }]);

    expect(trailing.text).toBe(' models');
    expect(trailing.segments).toEqual([{ key: 'alias.count_other', start: 0, end: 7 }]);
  });

  it('supports nested withoutUiTextEditorMarkers suppression safely', () => {
    const result = withoutUiTextEditorMarkers(() => withoutUiTextEditorMarkers(() => 'plain'));
    expect(result).toBe('plain');
  });
});
