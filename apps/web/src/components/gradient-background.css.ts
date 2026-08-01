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
// The stops are ours as well, and they are not the neutral ramp. Light carries
// a blue cast and dark runs a step deeper at the foot than any page fill WinUI
// states -- both deliberate, because a canvas mixed from the same greys as the
// cards on top of it reads as one flat sheet, which is the one thing Mica never
// looks like. Mica is a tinted sample of the wallpaper, so it carries a colour
// the window's own surfaces do not; the cast here stands in for that.
//
// The surfaces drawn over it do read the neutral ramp, through ../winui/theme.ts.
// The canvas being slightly off it is what separates them.
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
      radial-gradient(circle at 50% 0%, #ffffff 0%, #f7fbff 36%, transparent 64%),
      linear-gradient(180deg, #f6f8fb 0%, #eef2f6 100%);
    height: 100dvh;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .floway-gradient-background {
      background-image:
        radial-gradient(circle at 50% 0%, #2d2d2d 0%, #242424 38%, transparent 68%),
        linear-gradient(180deg, #1f1f1f 0%, #171717 100%);
    }
  }
`;
