export const avatarCss = `
.floway-identity {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  font-size: var(--fontSizeBase300);
  font-weight: var(--fontWeightRegular);
  line-height: var(--lineHeightBase300);
}

.floway-identity-action {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: var(--borderRadiusMedium);
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  max-width: 100%;
  min-width: 0;
  padding: 0;
  text-align: start;
  text-decoration: none;
}

.floway-identity-action:hover {
  text-decoration: none;
}

.floway-identity-action:disabled {
  color: var(--winui-text-fill-disabled);
  cursor: default;
}

.floway-identity-token.fui-Tag {
  --floway-chip-stroke: transparent;
  background-color: transparent;
  border-color: transparent;
  column-gap: var(--spacingHorizontalXS);
  height: auto;
  padding: 0;
}

.floway-identity-token .fui-Tag__primaryText.fui-Tag__primaryText {
  display: flex;
  padding: 0;
}

.floway-identity-token .fui-Tag__dismissIcon {
  margin: 0;
}

/* Group pictures use Fluent's Medium square-Avatar radius, one step above
   the native size-24 Small radius. Their painted surface is inset 2% on every
   edge to balance circular user pictures without scaling the initials.
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-avatar/library/src/components/Avatar/useAvatarStyles.styles.ts#L119-L122
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-avatar/library/src/components/Avatar/useAvatarStyles.styles.ts#L513-L519 */
.floway-group-avatar.fui-Avatar {
  border-radius: var(--borderRadiusMedium);
}

.floway-group-avatar .fui-Avatar__initials,
.floway-group-avatar .fui-Avatar__icon {
  inset: 2%;
  width: 96%;
  height: 96%;
}

/* PersonPicture uses a neutral disc with a card stroke. Identity colors remain
   available through Fluent's explicit non-neutral color variants.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/PersonPicture/PersonPicture_themeresources.xaml#L5-L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/PersonPicture/PersonPicture.xaml#L65-L66 */
.fui-Avatar[data-winui-avatar-color='neutral'] .fui-Avatar__initials.fui-Avatar__initials,
.fui-Avatar[data-winui-avatar-color='neutral'] .fui-Avatar__icon.fui-Avatar__icon {
  background-color: var(--winui-control-alt-fill-quarternary);
  border-color: var(--winui-card-stroke-default);
  color: var(--winui-text-fill-primary);
}

/* Neutral PersonPicture initials scale with the picture. Explicit identity
   colors retain Fluent Web's typography along with its palette.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/PersonPicture/PersonPicture.cpp#L593-L601 */
.fui-Avatar[data-winui-avatar-color='neutral'] .fui-Avatar__initials.fui-Avatar__initials {
  font-size: max(1px, calc(var(--floway-person-picture-size) * 0.42));
}

`;
