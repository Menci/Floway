import { useState } from 'react';

import type { RequestArchive } from './archive';
import { downloadArchive } from './export';
import { PipelineViewer } from './pipeline-viewer';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import type { DecodedDump } from '@floway-dev/dump/browser';

export interface RequestDetail extends RequestArchive {
  readonly dump: DecodedDump;
}

export function RequestDetailPanel({ error, record, recordId, retainLastRecord }: {
  error: string | null;
  record: RequestDetail | null;
  recordId: string | null;
  retainLastRecord: boolean;
}) {
  const [last, setLast] = useState({ error, record, recordId });
  const shown = retainLastRecord && recordId === null ? last : { error, record, recordId };
  if (last.record !== shown.record || last.error !== shown.error || last.recordId !== shown.recordId) setLast(shown);
  const { t } = useTranslation();
  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('requests.selectPrompt')}</EmptyStateLine>;
  if (shown.error) return <OutcomeMessageBar className="!m-4">{shown.error}</OutcomeMessageBar>;
  const detail = shown.record;
  if (!detail) return null;
  return <PipelineViewer key={detail.id} dump={detail.dump} onDownload={() => downloadArchive(detail)} />;
}
