// The synchronous legacy command runs first because it is the only path still
// inside the click's user gesture, and the only one at all outside a secure
// context; awaiting the Clipboard API first spends the gesture.
// https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
export const copyToClipboard = async (text: string): Promise<boolean> => {
  if (copyWithExecCommand(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('Copying to the clipboard failed.', error);
    return false;
  }
};

const copyWithExecCommand = (text: string): boolean => {
  const previousFocus = document.activeElement;
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const textArea = document.createElement('textarea');
  // Copying requires a focusable, selectable node, so it is made invisible
  // rather than hidden.
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.width = '2em';
  textArea.style.height = '2em';
  textArea.style.padding = '0';
  textArea.style.border = 'none';
  textArea.style.outline = 'none';
  textArea.style.boxShadow = 'none';
  textArea.style.background = 'transparent';
  textArea.value = text;

  try {
    document.body.append(textArea);
    textArea.focus();
    textArea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textArea.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
};
