import { CheckmarkCircleRegular, CircleRegular, DismissCircleRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import { formatDecodedJson, formatDiffPath, formatErrorValue } from './format-value';
import type { LoadedDumpArtifact } from './use-dump-artifact';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { Chip } from '../ui/chip';
import { ChoiceGroup } from '../ui/choice-group';
import { CodeBlock } from '../ui/code-block';
import { EmptyStateLine } from '../ui/empty-state';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import {
  computeStageDiffs,
  getStreamLineage,
  isDecodedStreamRef,
  type DecodedStageNode,
  type DumpViewModel,
  type StageDiff,
  type StructuralDiffEntry,
} from '@floway-dev/dump/browser';

const { Text, mergeClasses } = fluentComponents;

type PipelineTab = 'diffs' | 'io' | 'streams' | 'logs';

export interface PipelineViewProps {
  artifact: LoadedDumpArtifact;
  isLiveStreaming?: boolean;
  selectedStageId: number | null;
  onSelectStage: (stageId: number) => void;
}

interface StageTreeRow {
  readonly stage: DecodedStageNode;
  readonly depth: number;
}

const flattenStages = (model: DumpViewModel): StageTreeRow[] => {
  const rows: StageTreeRow[] = [];
  const visit = (stageId: number, depth: number) => {
    const stage = model.stages.get(stageId)!;
    rows.push({ stage, depth });
    for (const childStageId of stage.childStageIds) visit(childStageId, depth + 1);
  };
  for (const stageId of model.rootStageIds) visit(stageId, 0);
  return rows;
};

const lastEventTime = (model: DumpViewModel): number => {
  let time = model.run?.done?.tMs ?? 0;
  for (const stage of model.stages.values()) {
    time = Math.max(time, stage.closedAtMs ?? stage.leftAtMs ?? stage.enteredAtMs, stage.logs.at(-1)?.tMs ?? 0);
  }
  for (const stream of model.streams.values()) {
    time = Math.max(time, stream.end?.tMs ?? stream.frames.at(-1)?.tMs ?? stream.createdAtMs);
  }
  for (const deferred of model.deferreds.values()) {
    time = Math.max(time, deferred.settlement?.tMs ?? deferred.createdAtMs);
  }
  return time;
};

const collectStreamRefs = (value: unknown, ids: Set<number>) => {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown) => {
    if (isDecodedStreamRef(candidate)) {
      ids.add(candidate.$stream);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
};

function JsonBlock({ code, label, tag }: { code: string; label: string; tag: string }) {
  const { copy, outcomeFor } = useCopyToClipboard();
  return <CodeBlock
    code={code}
    copyOutcome={outcomeFor(tag)}
    language="json"
    onCopy={() => copy(code, tag)}
    header={<span>{label}</span>}
  />;
}

function PlainBlock({ code, label, tag }: { code: string; label: string; tag: string }) {
  const { copy, outcomeFor } = useCopyToClipboard();
  return <CodeBlock
    code={code}
    copyOutcome={outcomeFor(tag)}
    language="plain"
    onCopy={() => copy(code, tag)}
    header={<span>{label}</span>}
  />;
}

function TreeRow({ row, selected, elapsed, onSelect }: {
  row: StageTreeRow;
  selected: boolean;
  elapsed: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { stage } = row;
  const duration = stage.durationMs ?? Math.max(0, elapsed - stage.enteredAtMs);
  const total = Math.max(1, elapsed);
  const left = stage.enteredAtMs / total * 100;
  const width = Math.max(1, duration / total * 100);
  const statusLabel = t(`requests.pipeline.status.${stage.status}`);
  const StatusIcon = stage.status === 'succeeded'
    ? CheckmarkCircleRegular
    : stage.status === 'failed' ? DismissCircleRegular : CircleRegular;
  const statusClass = stage.status === 'succeeded'
    ? 'text-[var(--winui-system-fill-success)]'
    : stage.status === 'failed' ? 'text-[var(--winui-system-fill-critical)]' : 'text-[var(--winui-accent-fill-default)]';
  const fill = stage.status === 'succeeded'
    ? 'var(--winui-system-fill-success)'
    : stage.status === 'failed' ? 'var(--winui-system-fill-critical)' : 'var(--winui-accent-fill-default)';

  return <button
    type="button"
    aria-pressed={selected}
    className={mergeClasses(
      'winui-focus-rect w-full min-w-0 border-0 border-b border-solid border-[var(--winui-divider-stroke-default)] bg-transparent px-3 py-2 text-left text-fui-fg1',
      selected ? 'bg-[var(--winui-subtle-fill-secondary)]' : 'hover:bg-[var(--winui-subtle-fill-tertiary)]',
    )}
    onClick={onSelect}
  >
    <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${row.depth * 14}px` }}>
      <StatusIcon aria-label={statusLabel} className={mergeClasses('block flex-none', statusClass)} fontSize={16} />
      <Text className="min-w-0 flex-1 font-mono" size={200} truncate wrap={false}>{stage.name}</Text>
      {stage.edge === 'subrun' && <Chip>{t('requests.subrunBadge')}</Chip>}
      <Text className="shrink-0 tabular-nums text-fui-fg3" size={100}>{formatDuration(duration, locale)}</Text>
    </span>
    <span aria-hidden="true" className="mt-1.5 ml-6 block h-1 overflow-hidden rounded-full bg-[var(--winui-subtle-fill-secondary)]">
      <span className="block h-full rounded-full" style={{ marginLeft: `${left}%`, maxWidth: `${width}%`, width: '100%', backgroundColor: fill }} />
    </span>
  </button>;
}

function DiffEntry({ entry, tag }: { entry: StructuralDiffEntry; tag: string }) {
  const { t } = useTranslation();
  const marker = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : '~';
  return <div className="grid gap-2 min-w-0">
    <div className="flex items-center gap-2 min-w-0">
      <Chip className="shrink-0 font-mono">{marker}</Chip>
      <span className="min-w-0 break-all font-mono text-fui-fg2">{formatDiffPath(entry.path)}</span>
    </div>
    {entry.kind !== 'added' && <JsonBlock code={formatDecodedJson(entry.before)} label={t('requests.requestBody')} tag={`${tag}-before`} />}
    {entry.kind !== 'removed' && <JsonBlock code={formatDecodedJson(entry.after)} label={t('requests.responseBody')} tag={`${tag}-after`} />}
  </div>;
}

function DiffSection({ diff, direction, tag }: { diff: StageDiff; direction: 'down' | 'up'; tag: string }) {
  const { t } = useTranslation();
  return <section className="grid gap-3 min-w-0">
    <Text block size={300} weight="semibold">
      {direction === 'down'
        ? t('requests.pipeline.downwardDiff', { stage: diff.childName })
        : t('requests.pipeline.upwardDiff', { stage: diff.childName })}
    </Text>
    {diff.entries.length === 0
      ? <Text size={200} className="text-fui-fg3">{t('requests.pipeline.unchanged')}</Text>
      : diff.entries.map((entry, index) => <DiffEntry key={`${entry.kind}-${formatDiffPath(entry.path)}-${index}`} entry={entry} tag={`${tag}-${entry.kind}-${index}`} />)}
  </section>;
}

function DiffsTab({ artifact, stage }: { artifact: LoadedDumpArtifact; stage: DecodedStageNode }) {
  const { t } = useTranslation();
  const diffs = useMemo(
    () => computeStageDiffs(artifact.viewModel, artifact.decoder, stage.stageId),
    [artifact.decoder, artifact.viewModel, stage.stageId],
  );
  if (diffs.downward.length === 0 && diffs.upward.length === 0)
    return <EmptyStateLine>{t('requests.pipeline.noDiffs')}</EmptyStateLine>;
  return <>
    {diffs.downward.map(diff => <DiffSection key={`down-${diff.childStageId}`} diff={diff} direction="down" tag={`down-${stage.stageId}-${diff.childStageId}`} />)}
    {diffs.upward.map(diff => <DiffSection key={`up-${diff.childStageId}`} diff={diff} direction="up" tag={`up-${stage.stageId}-${diff.childStageId}`} />)}
  </>;
}

function IoTab({ stage }: { stage: DecodedStageNode }) {
  const { t } = useTranslation();
  return <>
    {stage.error !== undefined && <section className="grid gap-2 min-w-0">
      <Text block size={300} weight="semibold">{t('requests.pipeline.stageError')}</Text>
      <PlainBlock
        code={formatErrorValue(stage.error)}
        label={t('requests.pipeline.stageError')}
        tag={`error-${stage.stageId}`}
      />
    </section>}
    <section className="grid gap-2 min-w-0">
      <Text block size={300} weight="semibold">{t('requests.pipeline.facts')}</Text>
      <JsonBlock code={formatDecodedJson(stage.facts)} label={t('requests.pipeline.facts')} tag={`facts-${stage.stageId}`} />
    </section>
    {(stage.responseFacts !== undefined || stage.failureFacts !== undefined) && <section className="grid gap-2 min-w-0">
      <Text block size={300} weight="semibold">{t('requests.pipeline.outcome')}</Text>
      <JsonBlock
        code={formatDecodedJson(stage.responseFacts ?? stage.failureFacts)}
        label={t('requests.pipeline.outcome')}
        tag={`outcome-${stage.stageId}`}
      />
    </section>}
  </>;
}

function streamLabel(model: DumpViewModel, streamId: number): string {
  const stream = model.streams.get(streamId);
  return `#${streamId}${stream?.label === undefined ? '' : ` ${stream.label}`}`;
}

function StreamCard({ model, streamId, tag }: { model: DumpViewModel; streamId: number; tag: string }) {
  const { t } = useTranslation();
  const streamNode = model.streams.get(streamId);
  if (streamNode === undefined) return null;
  const lineage = getStreamLineage(model, streamId);
  const lineageNodes = lineage.map(id => model.streams.get(id)!);
  const linear = lineageNodes.slice(1).every((node, index) => node.wraps?.length === 1 && node.wraps[0] === lineage[index]);
  const recentFrames = streamNode.frames.slice(-4).map(frame => ({
    index: frame.index,
    tMs: frame.tMs,
    deltaMs: frame.deltaMs,
    value: frame.value,
  }));
  return <section className="grid gap-2 min-w-0 pb-3 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)] last:border-b-0">
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Text size={300} weight="semibold">{streamLabel(model, streamId)}</Text>
      {streamNode.end !== undefined && <Chip>{t(`requests.pipeline.streamEnd.${streamNode.end.how}`)}</Chip>}
      <Text size={200} className="text-fui-fg3">{t('requests.pipeline.streamFrames', { count: streamNode.frames.length })}</Text>
    </div>
    <div className="flex flex-wrap items-center gap-1 text-fui-fg2 font-mono">
      {linear ? lineage.map((lineageId, index) => <span key={lineageId} className="inline-flex items-center gap-1">
        {index > 0 && <span aria-hidden="true">→</span>}
        <span>{streamLabel(model, lineageId)}</span>
      </span>) : lineageNodes.filter(node => node.wraps?.length).map(node => <span key={node.streamId} className="inline-flex items-center gap-1">
        {node.wraps!.map((inputId, index) => <span key={inputId} className="inline-flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">+</span>}
          <span>{streamLabel(model, inputId)}</span>
        </span>)}
        <span aria-hidden="true">→</span>
        <span>{streamLabel(model, node.streamId)}</span>
      </span>)}
    </div>
    <JsonBlock code={formatDecodedJson(recentFrames)} label={t('requests.pipeline.tabs.streams')} tag={`${tag}-${streamId}`} />
  </section>;
}

function StreamsTab({ model, stage }: { model: DumpViewModel; stage: DecodedStageNode }) {
  const { t } = useTranslation();
  const ids = new Set<number>(stage.createdStreamIds);
  collectStreamRefs(stage.facts, ids);
  collectStreamRefs(stage.responseFacts, ids);
  collectStreamRefs(stage.failureFacts, ids);
  if (ids.size === 0) return <EmptyStateLine>{t('requests.pipeline.noStreams')}</EmptyStateLine>;
  return <>{[...ids].map(streamId => <StreamCard key={streamId} model={model} streamId={streamId} tag={`stream-${stage.stageId}`} />)}</>;
}

function LogsTab({ stage }: { stage: DecodedStageNode }) {
  const { t } = useTranslation();
  if (stage.logs.length === 0) return <EmptyStateLine>{t('requests.pipeline.noLogs')}</EmptyStateLine>;
  return <>{stage.logs.map(log => <section key={log.seq} className="grid gap-2 min-w-0 pb-3 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)] last:border-b-0">
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <Chip>{log.level}</Chip>
      <Text size={100} className="font-mono tabular-nums text-fui-fg3">+{log.tMs}ms</Text>
      <Text size={200} className="min-w-0 break-words">{log.message}</Text>
    </div>
    {log.fields !== undefined && <JsonBlock
      code={formatDecodedJson(log.fields)}
      label={t('requests.pipeline.tabs.logs')}
      tag={`log-${stage.stageId}-${log.seq}`}
    />}
  </section>)}</>;
}

function StageInspector({ artifact, onTabChange, stage, tab }: {
  artifact: LoadedDumpArtifact;
  onTabChange: (tab: PipelineTab) => void;
  stage: DecodedStageNode | undefined;
  tab: PipelineTab;
}) {
  const { t } = useTranslation();
  if (stage === undefined) return null;
  return <div className="flex h-full min-h-0 flex-col">
    <div className={mergeClasses(PANEL_BAND_CLASS, 'shrink-0 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]')}>
      <ChoiceGroup
        ariaLabel={t('requests.pipeline.tabs.label')}
        items={[
          { value: 'diffs', label: t('requests.pipeline.tabs.diffs') },
          { value: 'io', label: t('requests.pipeline.tabs.io') },
          { value: 'streams', label: t('requests.pipeline.tabs.streams') },
          { value: 'logs', label: t('requests.pipeline.tabs.logs') },
        ]}
        onChange={value => onTabChange(value as PipelineTab)}
        value={tab}
      />
    </div>
    <ScrollArea axes="vertical" className="flex-1 min-h-0" contentClassName="grid gap-4 p-[var(--floway-panel-inset)]">
      {tab === 'diffs' && <DiffsTab artifact={artifact} stage={stage} />}
      {tab === 'io' && <IoTab stage={stage} />}
      {tab === 'streams' && <StreamsTab model={artifact.viewModel} stage={stage} />}
      {tab === 'logs' && <LogsTab stage={stage} />}
    </ScrollArea>
  </div>;
}

export function PipelineView({ artifact, isLiveStreaming = false, selectedStageId, onSelectStage }: PipelineViewProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PipelineTab>('diffs');
  const rows = useMemo(() => flattenStages(artifact.viewModel), [artifact]);
  const lastTime = useMemo(() => lastEventTime(artifact.viewModel), [artifact]);
  const running = isLiveStreaming && artifact.viewModel.run !== null && artifact.viewModel.run.done === undefined;
  const now = useNow(250, running);
  const elapsed = Math.max(lastTime, running ? now - artifact.viewModel.run!.startedAt : 0);
  const activeStageId = selectedStageId !== null && artifact.viewModel.stages.has(selectedStageId)
    ? selectedStageId
    : rows[0]?.stage.stageId ?? null;
  const activeStage = activeStageId === null ? undefined : artifact.viewModel.stages.get(activeStageId);
  return <div className="flex h-full min-h-0 flex-col">
    <div className={mergeClasses(PANEL_BAND_CLASS, 'flex flex-wrap items-center gap-x-4 gap-y-1 shrink-0 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]')}>
      {artifact.viewModel.run !== null && <Text weight="semibold">{artifact.viewModel.run.pipeline}</Text>}
      <Text size={200} className="text-fui-fg3">{t('requests.pipeline.stages', { count: artifact.viewModel.stages.size })}</Text>
      <Text size={200} className="text-fui-fg3">{t('requests.pipeline.streams', { count: artifact.viewModel.streams.size })}</Text>
    </div>
    <div className="grid flex-1 min-h-0 grid-cols-[minmax(260px,340px)_minmax(0,1fr)] max-[820px]:grid-cols-1 max-[820px]:grid-rows-[minmax(180px,0.45fr)_minmax(0,1fr)]">
      <div className="min-h-0 border-r border-r-solid border-r-[var(--winui-divider-stroke-default)] max-[820px]:border-r-0 max-[820px]:border-b max-[820px]:border-b-solid max-[820px]:border-b-[var(--winui-divider-stroke-default)]">
        <ScrollArea axes="vertical" className="h-full min-h-0">
          {rows.map(row => <TreeRow
            key={row.stage.stageId}
            row={row}
            selected={row.stage.stageId === activeStageId}
            elapsed={elapsed}
            onSelect={() => onSelectStage(row.stage.stageId)}
          />)}
        </ScrollArea>
      </div>
      <div className="min-h-0">
        <StageInspector artifact={artifact} stage={activeStage} tab={tab} onTabChange={setTab} />
      </div>
    </div>
  </div>;
}
