export const tagPickerCss = `
/* TokenizingTextBox is a text control: TextControl brushes and a focused
   1,1,1,2 border, not ComboBox's detached focus frame. The compact presenter
   padding belongs to the token container; Fluent's aside still reserves the
   space its disclosure glyph occupies.
   https://github.com/CommunityToolkit/Windows/blob/6d537b47e243a8193e36258a5319d4ec7ea3197c/components/TokenizingTextBox/src/TokenizingTextBox.xaml#L12-L13
   https://github.com/CommunityToolkit/Windows/blob/6d537b47e243a8193e36258a5319d4ec7ea3197c/components/TokenizingTextBox/src/TokenizingTextBox.xaml#L117-L148
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources.xaml#L10-L12 */
.fui-TagPickerControl.fui-TagPickerControl {
  border-radius: var(--winui-control-corner-radius);
  min-width: 0;
  padding-block: 2px;
  padding-inline: 3px calc(3px + var(--fui-TagPickerControl-aside-width, 0px));
}

.fui-TagPickerInput.fui-TagPickerInput::placeholder {
  color: var(--winui-text-fill-secondary);
}

@media not (forced-colors: active) {
  .fui-TagPickerControl.fui-TagPickerControl {
    background-color: var(--winui-control-fill-default);
    border-color: var(--winui-control-elevation-border-color);
  }

  .fui-TagPickerControl.fui-TagPickerControl:hover:not(:focus-within):not(:has(.fui-TagPickerInput:disabled)) {
    background-color: var(--winui-control-fill-secondary);
    border-color: var(--winui-control-elevation-border-color);
  }

  .fui-TagPickerControl.fui-TagPickerControl:focus-within:not(:has(.fui-TagPickerInput:disabled)) {
    background-color: var(--winui-control-fill-input-active);
    border-color: var(--winui-control-stroke-default);
    outline: none;
    box-shadow: none;
  }

  .fui-TagPickerControl.fui-TagPickerControl::after,
  .fui-TagPickerControl.fui-TagPickerControl:focus-within:active::after {
    border-bottom-color: var(--winui-accent-base);
  }

  .fui-TagPickerControl.fui-TagPickerControl:has(.fui-TagPickerInput:disabled) {
    background-color: var(--winui-control-fill-disabled);
    border-color: var(--winui-control-stroke-default);
  }
}

/* The disclosure is a button inside a text control, so its foreground follows
   the text control's button ramp.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L43-L47 */
.fui-TagPickerControl__expandIcon.fui-TagPickerControl__expandIcon {
  color: var(--winui-text-fill-secondary);
  font-size: 12px;
}

.fui-TagPickerControl:has(.fui-TagPickerInput:disabled) .fui-TagPickerControl__expandIcon.fui-TagPickerControl__expandIcon {
  color: var(--winui-text-fill-disabled);
}
`;
