import blossomUrl from '../assets/emoji-blossom.svg?no-inline';
import broccoliUrl from '../assets/emoji-broccoli.svg?no-inline';
import cherryBlossomUrl from '../assets/emoji-cherry-blossom.svg?no-inline';
import hibiscusUrl from '../assets/emoji-hibiscus.svg?no-inline';
import snowflakeUrl from '../assets/emoji-snowflake.svg?no-inline';

// The marks the app draws itself with, and the hue each one paints beside.
//
// They ship as artwork rather than as emoji characters, because a character is
// drawn by whatever font the reader's platform supplies -- Apple Color Emoji
// draws a yellow daisy where Windows draws a lavender one -- and the tile in
// ./logo.tsx is computed from a hue this file has to know in advance. The
// artwork settles both: one drawing everywhere, and a hue that describes it.
//
// Fluent Emoji is Microsoft's own set and the design Windows 11 renders. The
// `Color` style is what the platform draws; `Flat` is the same shapes with the
// shading removed, a fifth of the bytes but not what a Windows reader sees.
//
// Each hue is the dominant hue of the file beside it, taken by rasterising that
// file at 256px and binning every pixel by hue in ten-degree steps, each
// weighted by alpha x saturation x value so that outlines and highlights --
// which carry little colour -- cannot outvote the petals. The heaviest bin's
// weighted mean is the colour, and its hue is what is recorded here.
const MARKS = [
  { hue: 346, url: cherryBlossomUrl },
  { hue: 272, url: blossomUrl },
  { hue: 315, url: hibiscusUrl },
  { hue: 197, url: snowflakeUrl },
  { hue: 153, url: broccoliUrl },
] as const;

// Drawn once per load rather than once per mount, so the logo, the tab and any
// second logo on the page are the same mark, and moving between pages does not
// reshuffle it.
export const mark = MARKS[Math.floor(Math.random() * MARKS.length)]!;
