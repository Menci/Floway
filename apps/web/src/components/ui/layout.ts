// WinUI states this gap as `0`
// (https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L409-L450),
// but only where every line carries its own full leading. Our `line-height` is
// tight, so the 4px stands in for that leading.
export const TIGHT_STACK_CLASS = 'grid gap-1';

// WinUI's `PART_ContentPresenter` states no spacing or breakpoint, so the 900px
// is ours, and each caller states its own gap.
export const HEADER_ROW_CLASS = 'flex items-center justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch';

// 680 because that is where `--floway-page-inset` and `--floway-panel-inset`
// already step down, so columns collapse as the space around them narrows.
export const TWO_COLUMN_FORM_CLASS = 'grid grid-cols-2 max-[680px]:grid-cols-1';

// Reads the page inset rather than stating a number, so the 680px step-down
// comes with the token and a shell needs no breakpoint of its own.
export const PANE_GAP_CLASS = 'gap-[var(--floway-page-inset)]';
