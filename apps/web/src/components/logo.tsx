import { mark } from './logo-mark';
import { fluentComponents } from '../fluent';
import { hsvToRgb, rgbToHex } from '../lib/color';

const { makeStyles } = fluentComponents;

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
