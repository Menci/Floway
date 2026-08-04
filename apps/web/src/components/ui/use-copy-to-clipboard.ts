import { CheckmarkRegular, CopyRegular, DismissRegular } from '@fluentui/react-icons';
import { createElement, useCallback, useState } from 'react';
import type { ReactElement } from 'react';

import { copyToClipboard } from './copy-to-clipboard';
import { useTranslation } from '../../i18n/translation';

const COPIED_MS = 1500;
const FAILED_MS = 2000;

export type CopyOutcome = 'idle' | 'copied' | 'failed';

const COPY_OUTCOME_ICON = {
  idle: CopyRegular,
  copied: CheckmarkRegular,
  failed: DismissRegular,
} as const;

export const copyOutcomeIcon = (outcome: CopyOutcome): ReactElement =>
  createElement(COPY_OUTCOME_ICON[outcome]);

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
   * whole table of them and a late expiry can only clear its own result.
   */
  copy: (text: string, tag?: string) => void;
  outcomeFor: (tag?: string) => CopyOutcome;
}

export const useCopyToClipboard = (): ClipboardCopy => {
  const [result, setResult] = useState<{ outcome: Exclude<CopyOutcome, 'idle'>; tag: string } | null>(null);

  const copy = useCallback((text: string, tag = '') => {
    // Synchronous up to the first await, so the legacy copy path inside still
    // runs within the click that asked for it.
    void copyToClipboard(text).then(copied => {
      const outcome = copied ? 'copied' : 'failed';
      setResult({ outcome, tag });
      window.setTimeout(() => {
        setResult(current => (current?.tag === tag && current.outcome === outcome ? null : current));
      }, copied ? COPIED_MS : FAILED_MS);
    });
  }, []);

  const outcomeFor = useCallback(
    (tag = ''): CopyOutcome => (result?.tag === tag ? result.outcome : 'idle'),
    [result],
  );

  return { copy, outcomeFor };
};
