// A WinUI 3 window paints this area with Mica, which samples the desktop
// wallpaper; the web can reach neither the wallpaper nor that recipe, so a
// fixed top-centre highlight falling into a vertical ramp stands in for it.
// The stops are ours: light carries a blue cast, and dark runs between the two
// page fills WinUI states, from the base at the top to the secondary at the
// foot -- the same one-step fall the light ramp makes, spelled in the palette
// rather than past it.
//
// The literals are spelled out rather than taken from `--winui-*`:
// ../critical.css.ts inlines this block into the document head so the canvas is
// correct on the first paint, and ../winui/tokens.ts arrives with the linked
// stylesheet, after it.
//
// Forced colors needs no rule: a gradient carries no url(), so background-image
// computes to none there and the element falls back to the user agent's Canvas
// -- which is what WinUI's HighContrast dictionary paints the page with too.
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2990
export const gradientBackgroundCss = `
  .floway-gradient-background {
    background-image:
      radial-gradient(circle at 50% 0%, #ffffff 0%, #f7fbff 36%, transparent 64%),
      linear-gradient(180deg, #f6f8fb 0%, #eef2f6 100%);
    height: 100dvh;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .floway-gradient-background {
      background-image:
        radial-gradient(circle at 50% 0%, #2d2d2d 0%, #242424 38%, transparent 68%),
        linear-gradient(180deg, #202020 0%, #1c1c1c 100%);
    }
  }
`;
