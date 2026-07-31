import { useCallback, useState } from 'react';

import { copyToClipboard } from '../../lib/copy-to-clipboard';

const COPIED_MS = 1500;
const FAILED_MS = 2000;

export interface ClipboardCopy {
  copiedTag: string | null;
  copyFailedTag: string | null;
  /**
   * `tag` names which button is showing the outcome, so one hook can serve a
   * whole table of them and a late expiry can only clear its own result. A
   * lone copy button leaves it out and reads the tags for non-null.
   */
  copy: (text: string, tag?: string) => void;
}

export const useCopyToClipboard = (): ClipboardCopy => {
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [copyFailedTag, setCopyFailedTag] = useState<string | null>(null);

  const copy = useCallback((text: string, tag = '') => {
    // Synchronous up to the first await, so the legacy copy path inside still
    // runs within the click that asked for it.
    void copyToClipboard(text).then(copied => {
      setCopiedTag(copied ? tag : null);
      setCopyFailedTag(copied ? null : tag);
      window.setTimeout(() => {
        const clear = copied ? setCopiedTag : setCopyFailedTag;
        clear(current => (current === tag ? null : current));
      }, copied ? COPIED_MS : FAILED_MS);
    });
  }, []);

  return { copiedTag, copy, copyFailedTag };
};
