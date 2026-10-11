// Native horizontal range navigation uses Segoe Fluent Icons EDD9/EDDA at 8px.
// The 2048-unit outlines preserve its rounded triangles and 6×8px painted ink.
// https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39
// https://github.com/jayfunc/BetterLyrics/blob/eede7df84ca5ded68a909dfea29094d83f00a384/src/BetterLyrics.DotNet/BetterLyrics.WinUI3/BetterLyrics.WinUI3/Assets/Fonts/SegoeFluentIcons.ttf
const paths = {
  left: 'M256 1024Q256 1118 300.0 1200.5Q344 1283 421 1336L1390 2002Q1424 2025 1459.0 2036.5Q1494 2048 1536 2048Q1588 2048 1635.0 2028.0Q1682 2008 1716.5 1973.5Q1751 1939 1771.5 1893.0Q1792 1847 1792 1794V254Q1792 201 1771.5 155.0Q1751 109 1716.5 74.5Q1682 40 1635.0 20.0Q1588 0 1536 0Q1457 0 1390 46L421 712Q344 765 300.0 847.5Q256 930 256 1024Z',
  right: 'M256 254V1794Q256 1847 276.5 1893.0Q297 1939 331.5 1973.5Q366 2008 412.5 2028.0Q459 2048 512 2048Q591 2048 658 2002L1627 1336Q1705 1282 1748.5 1200.0Q1792 1118 1792 1024Q1792 930 1748.5 848.0Q1705 766 1627 712L658 46Q591 0 512 0Q459 0 412.5 20.0Q366 40 331.5 74.5Q297 109 276.5 155.0Q256 201 256 254Z',
};
export const CalendarNavigationIcon = ({ direction }: { direction: keyof typeof paths }) => <svg aria-hidden="true" fill="currentColor" viewBox="0 0 2048 2048"><path d={paths[direction]} transform="translate(0 2048) scale(1 -1)" /></svg>;
