export const scopeExpressionCss = String.raw`
/* Compound path editors use the existing TextBox brush and corner tokens.
   Height remains content-driven so wrapped paths keep the same field surface.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L23-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L48-L65
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L194-L199 */
.floway-scope-editor {
  --floway-scope-editor-border-width: 1px;
  --floway-scope-editor-min-height: 34px;
  align-items: center;
  background: var(--winui-control-fill-default);
  border: var(--floway-scope-editor-border-width) solid var(--winui-control-stroke-default);
  border-bottom-color: var(--winui-control-strong-stroke-default);
  border-radius: var(--winui-control-corner-radius);
  display: inline-flex;
  gap: 4px;
  min-height: var(--floway-scope-editor-min-height);
  max-width: 100%;
  min-width: 240px;
  padding: 0 11px;
  position: relative;
  width: fit-content;
}

.floway-scope-editor > .floway-scope-expression {
  flex: 1;
}

/* Keep the small action in the last standard-height line when the path wraps.
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts */
.floway-scope-editor > .fui-Button {
  --floway-scope-editor-action-size: 24px;
  align-self: flex-end;
  height: var(--floway-scope-editor-action-size);
  margin-block-end: calc((var(--floway-scope-editor-min-height) - 2 * var(--floway-scope-editor-border-width) - var(--floway-scope-editor-action-size)) / 2);
}

.floway-scope-editor:not([aria-disabled='true']),
.floway-scope-expression[role='group'] .floway-scope-expression-slash {
  cursor: text;
}

.floway-scope-editor:hover:not([aria-disabled='true']) {
  background: var(--winui-control-fill-secondary);
}

.floway-scope-editor:focus-within:not([aria-disabled='true']) {
  background: var(--winui-control-fill-input-active);
  border-color: var(--winui-control-stroke-default);
}

.floway-scope-editor:focus-within::after {
  border-bottom: 2px solid var(--winui-accent-base);
  border-radius: inherit;
  content: '';
  inset: -1px;
  pointer-events: none;
  position: absolute;
}

.floway-scope-editor[aria-disabled='true'] {
  background: var(--winui-control-fill-disabled);
  color: var(--winui-text-fill-disabled);
}

.floway-scope-editor-header {
  align-items: baseline;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  margin-bottom: 8px;
  min-width: 0;
}

/* The inline mode switch shares its label's baseline; only the space below
   the tab text is retained for the selection indicator. */
.floway-scope-editor-header .fui-TabList {
  align-items: baseline;
}

.floway-scope-editor-header .fui-Tab.fui-Tab {
  align-items: baseline;
  min-height: 0;
  padding-top: 0;
}

.floway-principal-picker.fui-Combobox:has(.floway-principal-picker-avatar) {
  column-gap: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.floway-principal-picker.fui-Combobox:has(.floway-principal-picker-avatar):has([data-combobox-clear-action]) {
  grid-template-columns: auto minmax(0, 1fr) auto auto;
}

.floway-principal-picker-avatar {
  align-items: center;
  display: flex;
  grid-area: 1 / 1;
  padding-inline-start: 11px;
  pointer-events: none;
}

.floway-principal-picker:has(.floway-principal-picker-avatar) .fui-Combobox__input {
  grid-column: 2;
  grid-row: 1;
  padding-inline-start: 4px;
}

.floway-principal-picker:has(.floway-principal-picker-avatar) .fui-Combobox__expandIcon,
.floway-principal-picker:has(.floway-principal-picker-avatar) .fui-Combobox__clearIcon {
  grid-column: 3;
  grid-row: 1;
}

.floway-principal-picker:has(.floway-principal-picker-avatar):has([data-combobox-clear-action]) .fui-Combobox__expandIcon {
  grid-column: 4;
}

/* Path buttons use BreadcrumbBar item padding, line boxes and focus margin.
   Each separator wraps with its following item. The 4px separator padding and
   inter-segment gap are application choices, as is medium weight for type labels;
   resource identities retain their own typography.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar.xaml#L158-L168
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar.xaml#L262-L272
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar_themeresources.xaml#L7-L9 */
.floway-scope-expression {
  --floway-scope-part-padding-block: 3px;
  /* Keep syntax hues while following the secondary/primary and tertiary/primary
     TextFill alpha ratios used by plain parts.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209-L211 */
  --floway-scope-expression-hover-opacity: calc(158 / 228);
  --floway-scope-expression-pressed-opacity: calc(114 / 228);
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalXS);
  min-width: 0;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L7 */
@media (prefers-color-scheme: dark) {
  .floway-scope-expression {
    --floway-scope-expression-hover-opacity: calc(197 / 255);
    --floway-scope-expression-pressed-opacity: calc(135 / 255);
  }
}

.floway-scope-expression-segment {
  align-items: center;
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
}

.floway-scope-expression-segment[data-scope-part='model'],
.floway-scope-expression-segment[data-scope-part='model'] .floway-scope-expression-part,
.floway-scope-expression-segment[data-scope-part='model'] .floway-scope-expression-part-control {
  align-items: flex-start;
}

.floway-scope-expression-segment[data-scope-part='model'] > .floway-scope-expression-slash {
  padding-block: var(--floway-scope-part-padding-block);
}

/* Preserve the rendered token's footprint on activation. Typing releases that
   sizing reference so the draft can grow and shrink with its contents. */
.floway-scope-expression-part-editor {
  display: inline-grid;
  max-width: 100%;
  min-width: 0;
  position: relative;
}

.floway-scope-expression-part-preview {
  display: flex;
  min-width: 0;
  visibility: hidden;
}

.floway-scope-expression-part-control {
  align-items: center;
  display: flex;
  max-width: 100%;
  min-width: 0;
}

.floway-scope-expression-part-editor[data-pristine] > .floway-scope-expression-part-control {
  inset: 0;
  position: absolute;
}

.floway-scope-expression-part {
  align-items: center;
  border-radius: var(--borderRadiusMedium);
  display: inline-flex;
  font-weight: var(--fontWeightRegular);
  gap: var(--spacingHorizontalXS);
  line-height: var(--lineHeightBase300);
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  padding: var(--floway-scope-part-padding-block) 1px;
  text-align: start;
}

button.floway-scope-expression-part {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.floway-scope-expression-part.floway-scope-expression-kind {
  font-weight: 500;
}

button.floway-scope-expression-part:hover {
  color: var(--winui-text-fill-secondary);
}

button.floway-scope-expression-part:hover .floway-scope-expression-regex {
  opacity: var(--floway-scope-expression-hover-opacity);
}

button.floway-scope-expression-part:active {
  color: var(--winui-text-fill-tertiary);
}

button.floway-scope-expression-part:active .floway-scope-expression-regex {
  opacity: var(--floway-scope-expression-pressed-opacity);
}

button.floway-scope-expression-part:focus-visible {
  box-shadow: 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  outline: var(--winui-focus-visual-primary-thickness) solid var(--winui-focus-stroke-outer);
  outline-offset: var(--winui-focus-visual-secondary-thickness);
}

.floway-scope-expression-slash {
  color: var(--winui-text-fill-secondary);
  display: flex;
  flex: none;
  line-height: var(--lineHeightBase300);
  padding: 0 4px;
}

.floway-scope-expression-segment > .floway-scope-expression-slash:first-child {
  padding-inline-start: 0;
}

.floway-scope-expression-append > svg {
  height: var(--lineHeightBase300);
  width: 16px;
}

.floway-scope-expression-dimmed {
  color: var(--winui-text-fill-secondary);
}

.floway-scope-expression-option {
  align-items: flex-start;
  display: inline-flex;
  gap: var(--spacingHorizontalXS);
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
}

.floway-scope-expression-regex {
  overflow-wrap: anywhere;
}

.floway-scope-expression-model-icon {
  --floway-scope-model-icon-size: 18px;
  flex: none;
  font-size: var(--floway-scope-model-icon-size);
  height: var(--floway-scope-model-icon-size);
  margin-block-start: calc((var(--lineHeightBase300) - var(--floway-scope-model-icon-size)) / 2);
  width: var(--floway-scope-model-icon-size);
}
`;
