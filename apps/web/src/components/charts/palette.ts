import { oklchToHex } from '../../lib/hue';

// These are the OKLCH hues of the former Fluent-inspired hex palette. Keeping
// its order and hue preserves each ordinary series' identity while one shared
// lightness and chroma make configured upstream hues comparable to it.
const SERIES_HUES = [251, 144, 10, 46, 302, 198, 54, 250, 128, 322] as const;

const SERIES_LIGHTNESS = 0.7;
const SERIES_CHROMA = 0.13;

// Near-achromatic gray bypassing `colorForHue` so the catch-all Other series
// stays visually distinct from every palette slot and configured upstream hue.
export const OTHER_SERIES_COLOR = oklchToHex(0.62, 0.01, 250);

export const hueForSeriesSlot = (slot: number): number => SERIES_HUES[slot % SERIES_HUES.length]!;

export const colorForHue = (hue: number): string => oklchToHex(SERIES_LIGHTNESS, SERIES_CHROMA, hue);
