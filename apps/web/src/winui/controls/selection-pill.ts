// The accent selection pill: the bar WinUI draws on the leading edge of a
// selected row. Three controls here draw one -- the list item, the combo box
// option and the navigation item -- and they agree on its 3px thickness and on
// its length, so both are stated once. Each control keeps the corner radius it
// states for itself, and the accent reaches the bar differently in the sheet
// that owns each, so neither is emitted here.
//
// The length departs from WinUI the same way in all three. WinUI pins it: 16px
// on the 32px ComboBoxItem, 16px on NavigationView's 36px left-pane row, and
// MAX(16, itemHeight - 40) on ListViewItem's, whose chrome is also where its
// 3px thickness comes from. The rows here grow with their content, so a quarter
// inset at each end stands in for the fixed length -- it reproduces 16px at the
// stock row height and holds the proportion as the row grows.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L324
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L325
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L221
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L1750-L1758
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/ListViewBaseItemPresenter_Partial.cpp#L945-L982
export const selectionPill = (cornerRadius: string) => `  border-radius: ${cornerRadius};
  inline-size: 3px;
  inset-block: 25%;`;
