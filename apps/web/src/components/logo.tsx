import blossomUrl from '../assets/emoji-blossom.svg?no-inline';
import broccoliUrl from '../assets/emoji-broccoli.svg?no-inline';
import cherryBlossomUrl from '../assets/emoji-cherry-blossom.svg?no-inline';
import hibiscusUrl from '../assets/emoji-hibiscus.svg?no-inline';
import snowflakeUrl from '../assets/emoji-snowflake.svg?no-inline';
import { fluentComponents } from '../fluent';
import { hsvToRgb, rgbToHex } from '../lib/color';

const { makeStyles } = fluentComponents;

// The marks the logo draws from, and the hue each one paints its tile with.
//
// They ship as artwork rather than as emoji characters, because a character is
// drawn by whatever font the reader's platform supplies -- Apple Color Emoji
// draws a yellow daisy where Windows draws a lavender one -- and the tile is
// computed from a hue this file has to know in advance. The artwork settles
// both: one drawing everywhere, and a hue that describes it.
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

// The tile, as saturation and value against whichever hue was drawn. Both steps
// are the fixed pink tile's own, read back off it: it already sat at a single
// hue, so only the hue had to become a variable for the same treatment to fit
// any mark. A cherry blossom therefore lands a few degrees from the tile this
// replaces, and every other mark is that tile in its own colour.
//
// The tile carries no border. Its own edge is what states the shape; the border
// it used to draw was a tenth of the way from the surface toward a stronger
// step of the same hue, which is not a difference the screen can render.
const SURFACE_LIGHT = [0.133, 0.973] as const;
const SURFACE_DARK = [0.652, 0.361] as const;

const tone = (hue: number, [saturation, value]: readonly [number, number]) =>
  rgbToHex(...hsvToRgb(hue, saturation, value));

const paint = (hue: number) => ({
  background: `light-dark(${tone(hue, SURFACE_LIGHT)}, ${tone(hue, SURFACE_DARK)})`,
});

// Drawn once per load rather than once per mount, so every logo on a page is
// the same mark and moving between pages does not reshuffle it.
const mark = MARKS[Math.floor(Math.random() * MARKS.length)]!;
const markPaint = paint(mark.hue);

const useMarkStyles = makeStyles({
  root: {
    alignItems: 'center',
    borderRadius: '6px',
    display: 'inline-flex',
    height: '36px',
    justifyContent: 'center',
    width: '36px',
  },
  glyph: { display: 'block', height: '24px', width: '24px' },
});

export function FlowayLogo() {
  const ms = useMarkStyles();

  return (
    <div className="inline-flex items-center min-w-0 gap-2.5 text-fui-fg2">
      <span aria-hidden="true" className={ms.root} style={markPaint}>
        <img alt="" className={ms.glyph} src={mark.url} />
      </span>
      <span
        className="font-fui-semibold text-fui-base500 leading-[var(--lineHeightBase500)]"
      >
        Floway
      </span>
    </div>
  );
}
