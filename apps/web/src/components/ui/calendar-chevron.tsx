// E76B/E76C outlines in a 2048-unit em preserve the native 8px glyph's painted
// bounds. A Fluent SVG with an 8px viewport has different ink dimensions.
// https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/CommonStyles/CalendarViewStyle.xaml#L449-L450
// https://github.com/jayfunc/BetterLyrics/blob/eede7df84ca5ded68a909dfea29094d83f00a384/src/BetterLyrics.DotNet/BetterLyrics.WinUI3/BetterLyrics.WinUI3/Assets/Fonts/SegoeFluentIcons.ttf
const paths = {
  left: 'M576 1024Q576 998 595 979L1299 275Q1318 256 1344 256Q1370 256 1389 275Q1408 294 1408 320Q1408 346 1389 365L731 1024L1389 1683Q1408 1702 1408 1728Q1408 1754 1389 1773Q1370 1792 1344 1792Q1318 1792 1299 1773L595 1069Q576 1050 576 1024Z',
  right: 'M640 1728Q640 1702 659 1683L1317 1024L659 365Q640 346 640 320Q640 294 659 275Q678 256 704 256Q730 256 749 275L1453 979Q1472 998 1472 1024Q1472 1050 1453 1069L749 1773Q730 1792 704 1792Q678 1792 659 1773Q640 1754 640 1728Z',
};
export const CalendarChevron = ({ direction }: { direction: keyof typeof paths }) => <svg aria-hidden="true" fill="currentColor" viewBox="0 0 2048 2048"><path d={paths[direction]} /></svg>;
