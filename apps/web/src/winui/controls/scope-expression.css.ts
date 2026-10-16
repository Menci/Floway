export const scopeExpressionCss = String.raw`
/* ScopeExpression follows WinUI BreadcrumbBar's inline item geometry: each
   item uses 1px horizontal / 3px vertical padding on a 20px line box, while
   the separator gets 2px horizontal padding. Its -3 FocusVisualMargin grows
   the two-stroke focus rectangle three pixels beyond the item. Scope values
   deliberately use medium rather than BreadcrumbBarItemFontWeight Normal so
   typed resource tokens remain distinct from their secondary-colour slashes.
   The editor uses the existing WinUI-derived Combobox and popup rules when a
   part becomes active.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar.xaml#L208-L213
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar.xaml#L280-L303
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Breadcrumb/BreadcrumbBar_themeresources.xaml#L7-L9 */
.floway-scope-expression {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
}

.floway-scope-expression-part {
  align-items: center;
  border-radius: var(--borderRadiusMedium);
  display: inline-flex;
  font-weight: 500;
  gap: var(--spacingHorizontalXS);
  line-height: 20px;
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 3px 1px;
}

button.floway-scope-expression-part,
button.floway-scope-expression-slash-trigger {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

button.floway-scope-expression-part:hover,
button.floway-scope-expression-slash-trigger:hover {
  color: var(--winui-text-fill-secondary);
}

button.floway-scope-expression-part:active,
button.floway-scope-expression-slash-trigger:active {
  color: var(--winui-text-fill-tertiary);
}

button.floway-scope-expression-part:focus-visible,
button.floway-scope-expression-slash-trigger:focus-visible {
  box-shadow: 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  outline: var(--winui-focus-visual-primary-thickness) solid var(--winui-focus-stroke-outer);
  outline-offset: var(--winui-focus-visual-secondary-thickness);
}

.floway-scope-expression-slash {
  color: var(--winui-text-fill-secondary);
  flex: none;
  line-height: 20px;
  padding: 0 2px;
}

.floway-scope-expression > .floway-scope-expression-slash:first-child {
  padding-inline-start: 0;
}

.floway-scope-expression-input {
  min-width: 132px;
  width: min(280px, 60vw);
}

.floway-scope-expression-dimmed {
  color: var(--winui-text-fill-secondary);
}

.floway-scope-expression-option {
  align-items: center;
  display: inline-flex;
  gap: var(--spacingHorizontalXS);
  min-width: 0;
}

.floway-scope-expression-mono {
  font-family: var(--fontFamilyMonospace);
}

.floway-scope-expression-regex {
  font-family: var(--fontFamilyMonospace);
  overflow-wrap: anywhere;
}
`;
