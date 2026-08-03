import blossomUrl from '../assets/emoji-blossom.svg?no-inline';
import broccoliUrl from '../assets/emoji-broccoli.svg?no-inline';
import cherryBlossomUrl from '../assets/emoji-cherry-blossom.svg?no-inline';
import hibiscusUrl from '../assets/emoji-hibiscus.svg?no-inline';
import snowflakeUrl from '../assets/emoji-snowflake.svg?no-inline';

// Artwork rather than emoji characters: a character is drawn by whatever font
// the reader's platform supplies, and the tile in ./logo.tsx needs a hue known
// in advance. Fluent Emoji `Color` is what Windows 11 draws; `Flat` is a fifth
// of the bytes but not what a Windows reader sees.
//
// Each hue is the dominant hue of the file beside it: rasterise at 256px, bin
// every pixel by hue in ten-degree steps weighted by alpha x saturation x
// value, and take the hue of the heaviest bin's weighted mean.
const MARKS = [
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

// Runs in the document head so the icon is set before the first paint; a draw
// in module scope would leave the tab wearing the previous page's icon until
// the bundle had parsed.
//
// What is stored is the draw, not the index it resolves to: an index stored
// today points at a different mark, or at nothing, once this list changes.
// Taking the remainder at read time keeps every stored value meaningful.
//
// Session storage keeps the mark across reloads and full-page navigations
// without following the reader into tomorrow. Its accessors throw where
// storage is denied (Safari private browsing, a partitioned third-party
// context), and the answer there is to draw one and carry on unpersisted.
//
// The result goes on a global rather than onto the document: React renders
// this app's whole document, so an attribute this script writes onto the html
// element is a hydration mismatch, which makes React discard the server tree
// and rebuild it, taking every node anything else had put in the body with it.
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

// Falls back to the first mark where there is no document to read: the
// build-time prerender, where the script above is inert text in the HTML it is
// writing.
export const currentMark = () => {
  const drawn = typeof window === 'undefined' ? undefined : window[MARK_GLOBAL];
  return MARKS[typeof drawn === 'number' ? drawn : 0]!;
};
