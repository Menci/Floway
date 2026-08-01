// The app window's canvas -- the one surface underneath every route, the login
// page included. It is decorative and non-interactive, so the only states it
// has are the two colour schemes and forced colors.
//
// A WinUI 3 window paints this area with Mica, which samples the desktop
// wallpaper, blurs it and tints it per theme. The web can reach neither the
// wallpaper nor that recipe, so the arrangement here is ours: a fixed highlight
// at the top centre falling into a vertical ramp, which gives the canvas the
// lit-from-above reading Mica gets from the wallpaper behind the title bar.
//
// The values are not ours. All four stops per scheme are WinUI's own
// SolidBackgroundFill ramp, taken in role order -- Quarternary is the brightest
// step and the centre of the highlight, Tertiary is where the highlight fades
// out, and the ramp beneath runs Base to Secondary. That keeps the canvas
// inside the same neutral range as every card, flyout and nav surface drawn on
// top of it, which read their fills from the same ramp through
// ../winui/theme.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L272-L275
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68-L71
//
// The literals are spelled out rather than taken from `--winui-*`:
// ../critical.css.ts inlines this block into the document head so the canvas is
// correct on the first paint, and ../winui/tokens.ts arrives with the linked
// stylesheet, after it.
//
// Forced colors needs no rule. A gradient carries no url(), so the whole
// `background-image` computes to none there and the element falls back to the
// user agent's Canvas -- which is what WinUI's HighContrast dictionary paints
// the page with as well, resolving ApplicationPageBackgroundThemeBrush to
// SystemColorWindowColor.
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2990
export const gradientBackgroundCss = `
  .floway-gradient-background {
    background-image:
      radial-gradient(circle at 50% 0%, #ffffff 0%, #f9f9f9 36%, transparent 64%),
      linear-gradient(180deg, #f3f3f3 0%, #eeeeee 100%);
    height: 100dvh;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .floway-gradient-background {
      background-image:
        radial-gradient(circle at 50% 0%, #2c2c2c 0%, #282828 36%, transparent 64%),
        linear-gradient(180deg, #202020 0%, #1c1c1c 100%);
    }
  }
`;
