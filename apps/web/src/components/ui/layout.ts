// WinUI states this gap as `0`
// (https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L409-L450),
// but only under `BaseTextBlockStyle`'s `LineStackingStrategy="MaxHeight"` and
// `TextLineBounds="Full"`, where every line carries its own full leading. Our
// CSS `line-height` is tight, so a literal `0` collapses the pair. The 4px is
// ours, and stands in for the leading that metric would have supplied.
export const TIGHT_STACK_CLASS = 'grid gap-1';

// WinUI's `PART_ContentPresenter` is a bare presenter with no panel or spacing
// opinion, so the 900px at which the actions drop under the title is ours. So is
// the gap, which each caller states rather than taking from here: a page header
// stands its actions off by 18px and a section header by 12px.
export const HEADER_ROW_CLASS = 'flex items-center justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch';

// WinUI declares no adaptive triggers for form columns — no `AdaptiveTrigger`
// and no `MinWindowWidth` key anywhere in microsoft-ui-xaml's `controls/dev/` —
// so this number is ours. It is 680 because that is where `--floway-page-inset`
// and `--floway-panel-inset` already step down, so a form's columns collapse at
// the same moment the space around them narrows.
export const TWO_COLUMN_FORM_CLASS = 'grid grid-cols-2 max-[680px]:grid-cols-1';

// What separates the two panes of a master–detail shell. It reads the page inset
// rather than stating a number of its own, so the 680px step-down comes with the
// token and a shell needs no breakpoint of its own for the gap.
//
// The one pane seam WinUI states is `NavigationView`'s, and it is `0` by
// construction: the content grid carries its own `1,1,0,0` border, `8,0,0,0`
// radius and layer fill, so the seam is that border rather than a gap
// (https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234).
// This token is for the shells inside a page, and its measure is ours.
export const PANE_GAP_CLASS = 'gap-[var(--floway-page-inset)]';
