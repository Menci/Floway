import { ArrowDownloadRegular, FlashRegular, TimerRegular, WarningRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { downloadRecords, type ExportableDumpRecord } from './export';
import { requestSeverity } from './format';
import { PipelineView } from './pipeline-view';
import { useDumpArtifact, type LoadedDumpArtifact } from './use-dump-artifact';
import { WireView } from './wire-view';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { ChoiceGroup } from '../ui/choice-group';
import { EmptyStateLine } from '../ui/empty-state';
import { HttpStatusBadge } from '../ui/http-badge';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { DumpMetadata } from '@floway-dev/gateway/browser';

const { Spinner, Text, Tooltip, mergeClasses } = fluentComponents;

type Perspective = 'wire' | 'pipeline';

export interface RequestDetailPanelProps {
  keyId?: string | null;
  recordId: string | null;
  meta?: DumpMetadata | null;
  isLive?: boolean;
  error: string | null;
  retainLastRecord: boolean;
  preloaded?: LoadedDumpArtifact | null;
}

interface ShownRecord {
  readonly keyId: string | null;
  readonly recordId: string | null;
  readonly meta: DumpMetadata | null;
  readonly isLive: boolean;
  readonly error: string | null;
  readonly preloaded: LoadedDumpArtifact | null;
}

const shownRecord = (props: RequestDetailPanelProps): ShownRecord => ({
  keyId: props.keyId ?? null,
  recordId: props.recordId,
  meta: props.meta ?? null,
  isLive: props.isLive ?? false,
  error: props.error,
  preloaded: props.preloaded ?? null,
});

const sameShownRecord = (left: ShownRecord, right: ShownRecord): boolean =>
  left.keyId === right.keyId
  && left.recordId === right.recordId
  && left.meta === right.meta
  && left.isLive === right.isLive
  && left.error === right.error
  && left.preloaded === right.preloaded;

export function RequestDetailPanel(props: RequestDetailPanelProps) {
  const { t } = useTranslation();
  const incoming = shownRecord(props);
  const [shown, setShown] = useState(incoming);
  // The URL drops `record` as the drawer begins closing. The exit animation
  // keeps painting the last artifact until the drawer unmounts.
  const retained = props.retainLastRecord && incoming.recordId === null ? shown : incoming;
  if (!sameShownRecord(shown, retained)) setShown(retained);
  const artifactState = useDumpArtifact({
    keyId: shown.keyId,
    recordId: shown.recordId,
    initialMeta: shown.meta,
    isLive: shown.isLive,
    initialError: shown.error,
    preloaded: shown.preloaded ?? undefined,
  });

  if (!shown.recordId) return <EmptyStateLine className="p-4">{t('requests.selectPrompt')}</EmptyStateLine>;
  if (artifactState.error !== null) return <OutcomeMessageBar className="!m-4">{t('requests.artifactReadError', { error: artifactState.error })}</OutcomeMessageBar>;
  if (artifactState.loading && artifactState.artifact === null)
    return <div className="p-4 flex items-center gap-2"><Spinner size="tiny" /><Text size={200} className="text-fui-fg3">{t('requests.loadingArtifact')}</Text></div>;
  if (artifactState.artifact === null) return null;

  return <ArtifactDetail key={`${shown.keyId}/${shown.recordId}`} artifact={artifactState.artifact} isLiveStreaming={artifactState.isLiveStreaming} resyncing={artifactState.resyncing} />;
}

function ArtifactDetail({ artifact, isLiveStreaming, resyncing }: { artifact: LoadedDumpArtifact; isLiveStreaming: boolean; resyncing: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [perspective, setPerspective] = useState<Perspective>('wire');
  const [selectedStageId, setSelectedStageId] = useState<number | null>(null);
  const meta = artifact.meta;
  const status = meta?.status ?? null;
  const truncation = artifact.viewModel.run?.truncated;
  const truncated = meta?.truncated === true || truncation !== undefined;
  const droppedEvents = meta?.droppedEvents ?? 0;
  const truncationLabel = droppedEvents > 0
    ? t('requests.truncatedTrace', { dropped: droppedEvents })
    : t(truncation?.reason === 'queue-limit' ? 'requests.traceQueueLimit' : 'requests.traceSizeLimit');
  const exportable: ExportableDumpRecord | null = meta === null ? null : { meta, events: artifact.events };

  return <div className="flex h-full min-h-0 flex-col">
    <div className={mergeClasses(PANEL_BAND_CLASS, 'flex flex-wrap items-center gap-2 min-w-0 shrink-0 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]')}>
      <ChoiceGroup
        ariaLabel={t('requests.perspective.label')}
        items={[
          { value: 'wire', label: t('requests.perspective.wire') },
          { value: 'pipeline', label: t('requests.perspective.pipeline') },
        ]}
        onChange={value => setPerspective(value as Perspective)}
        value={perspective}
      />
      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--winui-divider-stroke-default)]" aria-hidden="true" />
      {(isLiveStreaming || resyncing) && meta === null
        ? <span role="status" className="inline-flex items-center gap-1.5 shrink-0"><Spinner size="extra-small" /><Text size={200}>{t(resyncing ? 'requests.resyncingArtifact' : 'requests.status.live')}</Text></span>
        : <HttpStatusBadge severity={requestSeverity(status, meta?.error ?? null)}>{status ?? t('requests.noStatus')}</HttpStatusBadge>}
      {meta !== null && <Tooltip content={t('requests.duration', { value: formatDuration(meta.durationMs, locale) })} relationship="description">
        <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
          <TimerRegular aria-hidden="true" className="block flex-none" fontSize={16} />
          <Text size={200} className="tabular-nums">{formatDuration(meta.durationMs, locale)}</Text>
        </span>
      </Tooltip>}
      {meta?.ttftMs != null && <Tooltip content={t('requests.ttft', { value: formatDuration(meta.ttftMs, locale) })} relationship="description">
        <span className="inline-flex items-center gap-1 shrink-0 text-fui-fg3">
          <FlashRegular aria-hidden="true" className="block flex-none" fontSize={16} />
          <Text size={200} className="tabular-nums">{formatDuration(meta.ttftMs, locale)}</Text>
        </span>
      </Tooltip>}
      {truncated && (
        <span className="inline-flex items-center gap-1 shrink-0 text-[var(--winui-system-fill-caution)]">
          <WarningRegular aria-hidden="true" />
          <Text size={200}>{truncationLabel}</Text>
        </span>
      )}
      <TooltipIconButton
        className="ml-auto"
        disabled={exportable === null}
        icon={<ArrowDownloadRegular />}
        label={t('requests.exportRecord')}
        onClick={() => { if (exportable !== null) downloadRecords([exportable]); }}
      />
    </div>
    <div className="flex-1 min-h-0">
      {perspective === 'wire'
        ? <WireView
            artifact={artifact}
            isLiveStreaming={isLiveStreaming}
            onInspectStage={stageId => {
              setSelectedStageId(stageId);
              setPerspective('pipeline');
            }}
          />
        : <PipelineView artifact={artifact} isLiveStreaming={isLiveStreaming} selectedStageId={selectedStageId} onSelectStage={setSelectedStageId} />}
    </div>
  </div>;
}
