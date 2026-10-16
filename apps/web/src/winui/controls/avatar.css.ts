export const avatarCss = `
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
