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

const MARK_GLOBAL = '__flowayMark';
const MARK_STORAGE_KEY = 'floway-mark';

declare global {
  var __flowayMark: number | undefined;
}

// The draw happens in the document head, before anything renders, and holds for
// the tab.
//
// It has to run before the first paint: the icon is the one part of the mark a
// reader sees before the app exists, so a draw in module scope would leave the
// tab wearing the previous page's icon until the bundle had parsed. Running here
// also makes this the single source of truth -- the logo reads the result rather
// than drawing again, so the tab and the page cannot disagree.
//
// What is stored is the draw itself, not the index it resolves to. An index is a
// number whose meaning depends on the length of a list this file is free to
// change: a stored 4 points at nothing the day a mark is removed, and at a
// different mark the day one is inserted. Storing the draw and taking the
// remainder at read time leaves every stored value meaningful for any list.
//
// Session storage rather than a draw per load, so the mark survives a reload and
// a full-page navigation without following the reader into tomorrow. Its
// accessors throw rather than return null where storage is denied -- Safari in
// private browsing, a partitioned third-party context -- and the answer there is
// the same as having nothing stored: draw one and carry on without persisting.
//
// The result is left on a global rather than on the document. React renders
// this app's whole document, so an attribute this script writes onto `<html>`
// is an attribute the prerendered HTML does not carry -- a hydration mismatch,
// which makes React discard the server tree and rebuild it, taking every node
// anything else had put in `<body>` with it. A global is invisible to
// reconciliation.
//
// The URLs are interpolated at build time because Vite hashes them, so the
// script is assembled beside the imports rather than written into the document
// by hand. It is inline, which a future Content-Security-Policy would have to
// admit with a nonce or a hash.
export const markPickerScript = `(function(){
var u=${JSON.stringify(MARKS.map(m => m.url))};
var k=${JSON.stringify(MARK_STORAGE_KEY)},d=null;
try{d=sessionStorage.getItem(k)}catch(e){}
if(d===null||!/^[0-9]+$/.test(d)){
d=String(Math.floor(Math.random()*2147483647));
try{sessionStorage.setItem(k,d)}catch(e){}
}
var i=Number(d)%u.length;
window[${JSON.stringify(MARK_GLOBAL)}]=i;
var l=document.createElement('link');
l.rel='icon';l.type='image/svg+xml';l.href=u[i];
document.head.appendChild(l);
})();`;

// What the head drew, for the logo to render. Falls back to the first mark when
// there is no document to read -- the build-time prerender, where the script is
// inert text in the HTML it is writing.
export const currentMark = () => {
  const drawn = typeof window === 'undefined' ? undefined : window[MARK_GLOBAL];
  return MARKS[Number.isInteger(drawn) ? drawn! : 0] ?? MARKS[0]!;
};
