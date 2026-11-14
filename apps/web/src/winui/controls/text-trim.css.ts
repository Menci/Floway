export const textTrimCss = `
/* Optical centering is a web typography choice, not a WinUI metric.
   Explicit text wrappers are needed inside flex controls: text-box-trim on a
   flex container cannot trim the anonymous item containing its text.
   Compound identities trim their names separately from their avatars.
   https://drafts.csswg.org/css-inline-3/#text-box-trim
   https://www.w3.org/TR/css-flexbox-1/#flex-items */
.floway-control-label {
  display: block;
  min-width: 0;
}

@supports (text-box-trim: trim-both) {
  .floway-control-label,
  .floway-identity-name,
  .floway-avatar-initials,
  .fui-Tag:not(:has(.fui-Tag__secondaryText, .floway-identity)) .fui-Tag__primaryText.fui-Tag__primaryText,
  .fui-InteractionTagPrimary:not(:has(.fui-InteractionTagPrimary__secondaryText)) .fui-InteractionTagPrimary__primaryText.fui-InteractionTagPrimary__primaryText,
  .fui-CompoundButton__secondaryContent.fui-CompoundButton__secondaryContent,
  .fui-MenuItem__subText.fui-MenuItem__subText,
  .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
    text-box-trim: trim-both;
    text-box-edge: cap alphabetic;
  }

  /* Symmetric padding keeps the original line height, including for wrapped
     labels, and protects accents/descenders inside truncation clips. */
  .floway-control-label,
  .floway-identity-name,
  .fui-Tag:not(:has(.fui-Tag__secondaryText, .floway-identity)) .fui-Tag__primaryText.fui-Tag__primaryText,
  .fui-InteractionTagPrimary:not(:has(.fui-InteractionTagPrimary__secondaryText)) .fui-InteractionTagPrimary__primaryText.fui-InteractionTagPrimary__primaryText,
  .fui-CompoundButton__secondaryContent.fui-CompoundButton__secondaryContent,
  .fui-MenuItem__subText.fui-MenuItem__subText,
  .fui-MenuItem__secondaryContent.fui-MenuItem__secondaryContent {
    padding-block: calc((1lh - 1cap) / 2);
  }
}
`;
