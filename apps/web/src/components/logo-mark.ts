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
export const MARKS = [
  { hue: 346, url: cherryBlossomUrl },
  { hue: 272, url: blossomUrl },
  { hue: 315, url: hibiscusUrl },
  { hue: 197, url: snowflakeUrl },
  { hue: 153, url: broccoliUrl },
] as const;

const MARK_ATTRIBUTE = 'data-floway-mark';

// The draw happens in the document head, before anything renders.
//
// It has to happen somewhere that runs once per load and before the first
// paint. A module-scope draw in this file would satisfy the first but not the
// second: the tab would keep the previous page's icon until the bundle had
// parsed and an effect had run, and the icon is the one part of the mark the
// reader sees before the app exists. Doing it here also makes the draw the
// single source of truth -- the logo reads the result rather than drawing
// again, so the tab and the page cannot disagree.
//
// The URLs are interpolated at build time because Vite hashes them; the script
// therefore has to be assembled where the imports are, not written by hand in
// the document. It is inline, so a future Content-Security-Policy would need a
// nonce or a hash for it.
export const markPickerScript = `(function(){
var u=${JSON.stringify(MARKS.map(m => m.url))};
var i=Math.floor(Math.random()*u.length);
document.documentElement.setAttribute(${JSON.stringify(MARK_ATTRIBUTE)},i);
var l=document.createElement('link');
l.rel='icon';l.type='image/svg+xml';l.href=u[i];
document.head.appendChild(l);
})();`;

// What the head drew, for the logo to render. Falls back to the first mark when
// there is no document to read -- the build-time prerender, where the script is
// inert text in the HTML it is writing.
export const currentMark = () => {
  if (typeof document === 'undefined') return MARKS[0]!;
  const drawn = Number(document.documentElement.getAttribute(MARK_ATTRIBUTE));
  return MARKS[Number.isInteger(drawn) ? drawn : 0] ?? MARKS[0]!;
};
