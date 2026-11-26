import { lazy, Suspense, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import type { DumpArchive } from '@floway-dev/dump/browser';

const PipelineViewer = lazy(() => import('./pipeline-viewer'));
const { Spinner } = fluentComponents;

interface RequestDetailInput {
  archive: DumpArchive | null;
  error: string | null;
  recordId: string | null;
  retainLastRecord: boolean;
}

export function RequestDetailPanel(input: RequestDetailInput) {
  const [shown, setShown] = useState(input);
  const incoming = input.retainLastRecord && input.recordId === null ? shown : input;
  if (shown.archive !== incoming.archive || shown.error !== incoming.error || shown.recordId !== incoming.recordId) setShown(incoming);
  const { t } = useTranslation();
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  return shown.archive === null ? null : <Suspense fallback={<Spinner />}><PipelineViewer key={shown.recordId} archive={shown.archive} /></Suspense>;
}
