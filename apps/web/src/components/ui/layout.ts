// WinUI states this gap as `0`
// (https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L409-L450),
// but only where every line carries its own full leading. Our `line-height` is
// tight, so the 4px stands in for that leading.
export const TIGHT_STACK_CLASS = 'grid gap-1';

// WinUI's `PART_ContentPresenter` states no spacing or breakpoint, so the 900px
// is ours, and each caller states its own gap.
export const HEADER_ROW_CLASS = 'flex items-center justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch';

// A heading stacked above the content it names takes SettingsCard's own
// header-to-content spacing, the one WinUI resource that states this distance:
// `SettingsCardVerticalHeaderContentSpacing` = 8, applied as the root grid's
// `RowSpacing` once the card wraps its content under its header.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L109
// and #L388-L393
export const SECTION_STACK_CLASS = 'grid gap-2';

// A panel stacks a heading over the body it introduces inside its own inset,
// which is the relationship WinUI states as `ContentDialogTitleMargin`'s 12px
// bottom — the only resource giving that distance on a padded surface rather
// than on a row. Peer blocks in the same panel take the same step, so a panel
// with no heading reads on the same rhythm.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17
// `!` because Griffel's `Card` sheet is injected after the utility sheet.
export const PANEL_STACK_CLASS = '!grid !gap-3';

// 680 because that is where `--floway-page-inset` and `--floway-panel-inset`
// already step down, so columns collapse as the space around them narrows.
export const TWO_COLUMN_FORM_CLASS = 'grid grid-cols-2 max-[680px]:grid-cols-1';

// Reads the page inset rather than stating a number, so the 680px step-down
// comes with the token and a shell needs no breakpoint of its own.
export const PANE_GAP_CLASS = 'gap-[var(--floway-page-inset)]';
