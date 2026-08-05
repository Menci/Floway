// NavItem, NavSubItem and NavCategoryItem share one Fluent root reset
// (sharedNavStyles.styles: useRootDefaultClassName), so rules below name all
// three and siblings stay in step.
//
// Rows that substitute a Fluent token rather than declare the property it feeds
// do so because the value is painted from a keyframe stop, which outranks every
// normal rule; the variable that stop reads is the one remaining input. See
// ./tokens.ts for the selector convention.
import { selectionPill } from './selection-pill';
import { notDisabled } from './selectors';

export const navCss = `
/* No seam on the pane's inline-end edge: WinUI draws that hairline from the
   content side, as the start edge of the ContentGrid card, and the dashboard's
   content region is not a card.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L290
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L234 */
.fui-NavDrawer.fui-InlineDrawer {
  border-inline-end-style: none;
}

/* Item foreground. The pending row -- held pressed for the length of a
   navigation -- takes the press state's secondary fill, which WinUI also states
   for a selected item.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L31 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  --colorNeutralForeground2: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active${notDisabled},
.fui-NavItem.fui-NavItem[data-nav-pending]${notDisabled},
.fui-NavSubItem.fui-NavSubItem:active${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem:active${notDisabled} {
  --colorNeutralForeground2: var(--winui-text-fill-secondary);
}

/* Item fill. Selection reads the same as hover here -- WinUI holds the ramp one
   step in for both -- so the indicator, not the fill, carries selection.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L9-L20 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem:hover${notDisabled},
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem:hover${notDisabled},
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem:hover${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* The fill switches rather than ramps. Every state in the presenter's
   PointerStates group is a bare VisualState.Setters block, and neither
   NavigationView dictionary declares a BrushTransition on an item -- WinUI says
   so where it wants one, as Button's ContentPresenter does at 83ms, which
   ./button.css.ts transcribes. Fluent's shared item reset ramps background over
   durationFaster, so the property is taken out of the transition here; with
   nothing left to ramp, there is no reduced-motion clamp to write.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L455-L496
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L172-L175 */
.fui-NavItem.fui-NavItem,
.fui-NavSubItem.fui-NavSubItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  transition-property: none;
}

/* Selection does not change the weight. NavigationViewItem states Normal for
   every state; Fluent's bolded selected label doubles a signal the indicator
   already carries and shifts the label's width as it lands.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L641 */
.fui-NavItem.fui-NavItem[aria-current='page'],
.fui-NavSubItem.fui-NavSubItem[aria-current='page'],
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'] {
  font-weight: var(--fontWeightRegular);
}

/* A NavItem's own indicator is cleared because WinUI's animates between the
   item losing selection and the one taking it, which a per-item pseudo-element
   cannot do; the sidebar draws a measured one instead. A category row is never
   an endpoint of that animation and a sub-item is rendered nowhere the measured
   indicator is drawn, so both keep a pseudo-element.

   Those two take the shared pill geometry at NavigationViewSelectionIndicator's
   own 2px radius, with Fluent's fixed indicator height released so the inset
   sets the length; the measured indicator is pinned at 20px to match what that
   inset gives them on the stock row.

   The accent is substituted rather than declared: the key frame Fluent ends
   this pseudo-element's entrance on paints background from
   colorCompoundBrandForeground1 and holds it, which is the case the note at the
   top of this file describes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L217
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L220-L222
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L48
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-nav/library/src/components/sharedNavStyles.styles.ts#L87-L103 */
.fui-NavItem.fui-NavItem::after {
  content: none;
}

.fui-NavSubItem.fui-NavSubItem[aria-current='page']::after,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']::after {
  --colorCompoundBrandForeground1: var(--winui-accent-fill-default);
${selectionPill('2px')}
  height: auto;
}

.fui-NavItem.fui-NavItem:active${notDisabled},
.fui-NavItem.fui-NavItem[data-nav-pending]${notDisabled},
.fui-NavItem.fui-NavItem[aria-current='page']:hover${notDisabled},
.fui-NavSubItem.fui-NavSubItem:active${notDisabled},
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:hover${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem:active${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:hover${notDisabled} {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-NavItem.fui-NavItem[aria-current='page']:active${notDisabled},
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:active${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:active${notDisabled} {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI leaves a disabled item on the transparent fill rather than dimming it,
   so the foreground below carries the whole disabled reading; a disabled
   selected item keeps its wash, so the pane still says which page one is on.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L20 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  background-color: var(--winui-subtle-fill-transparent);
}

.fui-NavItem.fui-NavItem[aria-current='page']:disabled,
.fui-NavItem.fui-NavItem[aria-current='page'][aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem[aria-current='page']:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-current='page'][aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page']:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-current='page'][aria-disabled='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

/* Fluent styles no disabled item anywhere in the nav package, so WinUI's dim
   is stated here; it is the same fill whether or not the item is selected.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L32 */
.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavSubItem.fui-NavSubItem:disabled,
.fui-NavSubItem.fui-NavSubItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  --colorNeutralForeground2: var(--winui-text-fill-disabled);
}

/* Focus. Fluent draws the outer stroke as an outline inside the border box, so
   only its colour is restated; the inner one is an inset shadow the full depth
   of the focus visual, of which the outline covers everything but the last
   pixel -- a shadow rather than the two-pseudo-element construction used
   elsewhere, because this item's ::after is spoken for by the selection
   indicator above.

   Fluent's data-fui-focus-visible marker can outlive the browser's actual
   :focus-visible state. The inner stroke therefore requires both: otherwise a
   stale marker leaves only its pale inset shadow, covering the selection pill
   and making the selected fill appear smaller after the outline is gone.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L429
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L15-L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L446-L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/inc/FocusRectNudging.h#L388 */
.fui-NavItem.fui-NavItem[data-fui-focus-visible]:focus-visible,
.fui-NavSubItem.fui-NavSubItem[data-fui-focus-visible]:focus-visible,
.fui-NavCategoryItem.fui-NavCategoryItem[data-fui-focus-visible]:focus-visible {
  box-shadow:
    inset 0 0 0 var(--winui-focus-visual-depth) var(--winui-focus-stroke-inner);
}

/* A selected item's icon keeps the primary text fill instead of Fluent's brand
   tint and follows the label through the remaining states; without that it
   would sit at full strength while the label moved. Only the two families that
   pair a selected state with an icon read this token.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L29
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L31
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L32 */
.fui-NavItem.fui-NavItem,
.fui-NavCategoryItem.fui-NavCategoryItem {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-primary);
}

.fui-NavItem.fui-NavItem:active${notDisabled},
.fui-NavItem.fui-NavItem[data-nav-pending]${notDisabled},
.fui-NavCategoryItem.fui-NavCategoryItem:active${notDisabled} {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-secondary);
}

.fui-NavItem.fui-NavItem:disabled,
.fui-NavItem.fui-NavItem[aria-disabled='true'],
.fui-NavCategoryItem.fui-NavCategoryItem:disabled,
.fui-NavCategoryItem.fui-NavCategoryItem[aria-disabled='true'] {
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-disabled);
}

/* Section header. NavigationViewItemHeaderTextStyle is 14 SemiBold, which is
   BodyStrong; Fluent sets caption1Strong's 12 instead, a size the WinUI ramp
   pairs with the regular weight and never with a strong one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L47
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L1081-L1083 */
.fui-NavSectionHeader.fui-NavSectionHeader {
  color: var(--winui-text-fill-secondary);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
}

/* The hairline separating the footer from the scrolling item list. Naming
   Fluent's ::before retints the card stroke ./drawer.css gives every drawer
   footer without bringing a seam into existence, and inherits Fluent's
   condition for it -- shown only while the drawer body is scrollable, the same
   condition NavigationView reveals its pane separator under.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L375
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.cpp#L1585-L1626
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L46 */
.fui-NavDrawerFooter.fui-NavDrawerFooter::before {
  background-color: var(--winui-divider-stroke-default);
}
`;
