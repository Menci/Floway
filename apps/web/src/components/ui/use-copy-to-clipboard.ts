import { CheckmarkRegular, CopyRegular, DismissRegular } from '@fluentui/react-icons';
import { createElement, useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

import { copyToClipboard } from '../../lib/copy-to-clipboard';

const COPIED_MS = 1500;
const FAILED_MS = 2000;

export type CopyOutcome = 'idle' | 'copied' | 'failed';

// The same three states drive every copy button's icon, so the mapping is named
// here and a button asks for the state it is in rather than deriving the icon.
const COPY_OUTCOME_ICON = {
  idle: CopyRegular,
  copied: CheckmarkRegular,
  failed: DismissRegular,
} as const;

// Rendered rather than returned as a component, because most copy buttons sit
// inline inside a row's JSX with nowhere to bind a name.
export const copyOutcomeIcon = (outcome: CopyOutcome): ReactElement =>
  createElement(COPY_OUTCOME_ICON[outcome]);

// The labels sit under `common` rather than under a page, because the control
// they belong to is not one page's.
//
// Only the resting label belongs to the call site -- "Copy", "Copy model ID",
// "Copy authorization URL" -- so that one is asked for and the two outcome
// labels are not.
const COPY_OUTCOME_LABEL_KEY = {
  copied: 'common.copy.copied',
  failed: 'common.copy.failed',
} as const;

export const useCopyLabel = (): ((outcome: CopyOutcome, idle: string) => string) => {
  const { t } = useTranslation();
  return useCallback(
    (outcome, idle) => (outcome === 'idle' ? idle : t(COPY_OUTCOME_LABEL_KEY[outcome])),
    [t],
  );
};

export interface ClipboardCopy {
  /**
   * `tag` names which button is showing the outcome, so one hook can serve a
   * whole table of them and a late expiry can only clear its own result. A lone
   * copy button leaves it out, and asks `outcomeFor` the same way.
   */
  copy: (text: string, tag?: string) => void;
  outcomeFor: (tag?: string) => CopyOutcome;
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

  const outcomeFor = useCallback((tag = ''): CopyOutcome => {
    if (copyFailedTag === tag) return 'failed';
    if (copiedTag === tag) return 'copied';
    return 'idle';
  }, [copiedTag, copyFailedTag]);

  return { copy, outcomeFor };
};
