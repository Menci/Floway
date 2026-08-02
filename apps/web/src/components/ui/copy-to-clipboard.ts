// Copying runs from a click, and only the synchronous path is guaranteed to
// still be inside that user gesture: `document.execCommand` is deprecated but
// cannot be defeated by anything having been awaited first, and it is the only
// path at all outside a secure context, where `navigator.clipboard` is not
// exposed. So the legacy command is tried first and the asynchronous Clipboard
// API is the fallback for when it fails or is unavailable -- ordering the two
// the other way round spends the gesture on the await and can leave the
// fallback unable to work.
// https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
// https://stackoverflow.com/questions/400212/how-do-i-copy-to-the-clipboard-in-javascript
export const copyToClipboard = async (text: string): Promise<boolean> => {
  if (copyWithExecCommand(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    // The boolean is the caller's contract and it does render the failure, but
    // "Copy failed" does not say whether the page lacks the permissions-policy
    // grant, the document was not focused, or the user refused the prompt --
    // which is the first thing anybody reporting this would be asked.
    console.warn('Copying to the clipboard failed.', error);
    return false;
  }
};

const copyWithExecCommand = (text: string): boolean => {
  const previousFocus = document.activeElement;
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const textArea = document.createElement('textarea');
  // The node has to be focusable and selectable to be copied from, which rules
  // out hiding it; it is made invisible instead.
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
    // Nobody should lose their place in the page because they copied something.
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  }
};
