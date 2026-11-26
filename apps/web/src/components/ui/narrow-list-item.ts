import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// The row of a list that stands in for a table at a narrow width. Only what
// ../../winui/controls/list.css.ts has no ListViewItem counterpart for: a
// multi-line row, and a divider separator rather than the card stroke, which is
// black in both themes and disappears against a dark page.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
export const useNarrowListItemClass = makeStyles({
  item: {
    borderBottom: '1px solid var(--winui-divider-stroke-default)',
    paddingBlock: '10px',
  },
});
