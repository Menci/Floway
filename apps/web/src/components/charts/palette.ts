// These are the OKLCH hues of the former Fluent-inspired hex palette. Keeping
// its order and hue preserves each ordinary series' identity while one shared
// lightness and chroma make configured upstream hues comparable to it.
const SERIES_HUES = [251, 144, 10, 46, 302, 198, 54, 250, 128, 322] as const;

const SERIES_LIGHTNESS = 0.7;
const SERIES_CHROMA = 0.13;

export const hueForSeriesSlot = (slot: number): number => SERIES_HUES[slot % SERIES_HUES.length]!;

export const colorForHue = (hue: number): string => `oklch(${SERIES_LIGHTNESS} ${SERIES_CHROMA} ${hue})`;
