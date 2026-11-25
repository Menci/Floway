import { ArrowDownloadRegular, ChevronLeftRegular, ChevronRightRegular, WarningRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown } from '../ui/fluent-form-controls';
import { PANE_GAP_CLASS } from '../ui/layout';
import { Panel, PANEL_BAND_CLASS, PANEL_INSET_CLASS } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { diffFacts, isDumpDeferredRef, isDumpRawJson, isDumpSecret, isDumpStreamRef } from '@floway-dev/dump/browser';
import type { DecodedDump, DumpResult, DumpStage, DumpStream } from '@floway-dev/dump/browser';
import { encodeBase64 } from '@floway-dev/protocols/browser';

const { Button, Option, Tab, TabList, Text, Tree, TreeItem, TreeItemLayout } = fluentComponents;
type Target = { type: 'streams' | 'deferreds'; id: number };
type SelectTarget = (target: Target) => void;

function Expand({ title, children, initiallyOpen = false }: { title: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details onToggle={event => setOpen(event.currentTarget.open)} open={open}>
    <summary className="cursor-pointer break-words"><Text weight="semibold">{title}</Text></summary>
    {open && <div className="mt-2 min-w-0">{children}</div>}
  </details>;
}

function DumpValue({ value, select, ancestors = [], initiallyOpen = false }: {
  value: unknown;
  select: SelectTarget;
  ancestors?: readonly object[];
  initiallyOpen?: boolean;
}) {
  const { t } = useTranslation();
  if (isDumpStreamRef(value)) return <Button appearance="subtle" size="small" onClick={() => select({ type: 'streams', id: value.$stream })}>
    {t('requests.pipeline.stream', { id: value.$stream })}
  </Button>;
  if (isDumpDeferredRef(value)) return <Button appearance="subtle" size="small" onClick={() => select({ type: 'deferreds', id: value.$deferred })}>
    {t('requests.pipeline.deferred', { id: value.$deferred })}
  </Button>;
  if (isDumpSecret(value)) return <span className="break-all font-mono" title={t('requests.pipeline.secret', { length: value.$secret.length })}>
    {value.$secret.redacted} {value.$secret.hash}
  </span>;
  if (value instanceof Uint8Array) return <Expand title={t('requests.pipeline.bytes', { length: value.length })}>
    <ByteValue bytes={value} />
  </Expand>;
  if (isDumpRawJson(value)) return <code className="whitespace-pre-wrap break-all">{value.rawJSON}</code>;
  if (value === null || typeof value !== 'object') {
    const text = typeof value === 'string' ? JSON.stringify(value) : Object.is(value, -0) ? '-0' : String(value);
    return <code className="whitespace-pre-wrap break-all">{text}</code>;
  }
  if (ancestors.includes(value)) return <Text italic>{t('requests.pipeline.circular')}</Text>;

  const next = [...ancestors, value];
  const fields = <ValueFields value={value} ancestors={next} select={select} />;
  return initiallyOpen ? fields : <Expand title={Array.isArray(value) ? '[…]' : '{…}'}>{fields}</Expand>;
}

const ByteValue = ({ bytes }: { bytes: Uint8Array }) => <code className="whitespace-pre-wrap break-all">{encodeBase64(bytes)}</code>;

function ValueFields({ value, ancestors, select }: { value: object; ancestors: readonly object[]; select: SelectTarget }) {
  const entries = Object.entries(value);
  if (!entries.length) return <code>{Array.isArray(value) ? '[]' : '{}'}</code>;
  return <dl className="m-0 flex min-w-0 flex-col gap-2">
    {entries.map(([key, child]: [string, unknown]) => <div key={key} className="min-w-0 border-s border-fui-stroke2 ps-2">
      <dt className="font-mono break-all">{key === '' ? '""' : key}</dt>
      <dd className="m-0 min-w-0 text-fui-fg2"><DumpValue value={child} ancestors={ancestors} select={select} /></dd>
    </div>)}
  </dl>;
}

function Changes({ before, after, select }: { before: unknown; after: unknown; select: SelectTarget }) {
  const { t } = useTranslation();
  const changes = diffFacts(before, after);
  if (!changes.length) return <Text>{t('requests.pipeline.noChanges')}</Text>;
  return <ol className="m-0 flex list-none flex-col gap-2 p-0">
    {changes.map(change => <li key={JSON.stringify(change.path)} className="min-w-0 border-s border-fui-stroke2 ps-2">
      <code className="break-all">{change.path.map(segment => `[${JSON.stringify(segment)}]`).join('')}</code>
      {change.kind === 'added' && <div><Text>{t('requests.pipeline.added')}</Text> <DumpValue value={change.after} select={select} /></div>}
      {change.kind === 'removed' && <div><Text>{t('requests.pipeline.removed')}</Text> <DumpValue value={change.before} select={select} /></div>}
      {change.kind === 'changed' && <>
        <div><Text>{t('requests.pipeline.before')}</Text> <DumpValue value={change.before} select={select} /></div>
        <div><Text>{t('requests.pipeline.after')}</Text> <DumpValue value={change.after} select={select} /></div>
      </>}
    </li>)}
  </ol>;
}

function StageDetails({ stage, dump, select }: { stage: DumpStage; dump: DecodedDump; select: SelectTarget }) {
  const { t } = useTranslation();
  const parent = stage.parentStageId === undefined ? undefined : dump.stages.get(stage.parentStageId);
  return <div className="flex min-w-0 flex-col gap-3">
    <Text as="h3" size={400} weight="semibold" className="m-0 break-all font-mono">{stage.name}</Text>
    <Expand title={t('requests.pipeline.requestFacts')} initiallyOpen>
      <DumpValue value={stage.requestFacts} select={select} initiallyOpen />
      {parent && <Expand title={t('requests.pipeline.parentChanges')}>
        <Changes before={parent.requestFacts} after={stage.requestFacts} select={select} />
      </Expand>}
    </Expand>
    {stage.responseFacts && <Expand title={t('requests.pipeline.responseFacts')} initiallyOpen>
      <DumpValue value={stage.responseFacts} select={select} initiallyOpen />
      <Expand title={t('requests.pipeline.changes')}><Changes before={stage.requestFacts} after={stage.responseFacts} select={select} /></Expand>
      {stage.childStageIds.map(id => {
        const child = dump.stages.get(id)!;
        return child.responseFacts && <Expand key={id} title={t('requests.pipeline.childChanges', { stage: child.name })}>
          <Changes before={child.responseFacts} after={stage.responseFacts} select={select} />
        </Expand>;
      })}
    </Expand>}
    {stage.panic && <Expand title={t('requests.pipeline.panic')} initiallyOpen>
      <DumpValue value={stage.panic.error} select={select} initiallyOpen />
      {stage.panic.facts && <Expand title={t('requests.pipeline.panicFacts')} initiallyOpen>
        <DumpValue value={stage.panic.facts} select={select} initiallyOpen />
        <Expand title={t('requests.pipeline.changes')}><Changes before={stage.requestFacts} after={stage.panic.facts} select={select} /></Expand>
      </Expand>}
    </Expand>}
    {stage.logs.length > 0 && <Expand title={t('requests.pipeline.logs')} initiallyOpen>
      {stage.logs.map((log, index) => <Expand key={index} title={`${log.level} ${log.message}`}>
        <DumpValue value={log} select={select} initiallyOpen />
      </Expand>)}
    </Expand>}
  </div>;
}

function StageItems({ dump, ids, select }: { dump: DecodedDump; ids: readonly number[]; select: (id: number) => void }) {
  return ids.map(id => {
    const stage = dump.stages.get(id)!;
    return <TreeItem key={id} itemType={stage.childStageIds.length ? 'branch' : 'leaf'} value={id}>
      <TreeItemLayout iconBefore={stage.panic ? <WarningRegular /> : undefined} onClick={() => select(id)}>
        <span className="font-mono break-all">{stage.name}</span>
      </TreeItemLayout>
      {stage.childStageIds.length > 0 && <Tree><StageItems dump={dump} ids={stage.childStageIds} select={select} /></Tree>}
    </TreeItem>;
  });
}

function ResultValue({ result, select }: { result: DumpResult<unknown>; select: SelectTarget }) {
  const { t } = useTranslation();
  return <div className="flex min-w-0 flex-col gap-2">
    <Text weight="semibold">{t(result.ok ? 'requests.pipeline.value' : 'requests.pipeline.error')}</Text>
    <DumpValue value={result.ok ? result.value : result.error} select={select} initiallyOpen />
  </div>;
}

function StreamFrames({ stream, select }: { stream: DumpStream; select: SelectTarget }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const frame = stream.frames[index];
  return <>
    <Text>{t(stream.ended ? 'requests.pipeline.ended' : 'requests.pipeline.interrupted')}</Text>
    {frame ? <>
      <div className="flex flex-wrap items-center gap-2">
        <Button aria-label={t('requests.pipeline.previousFrame')} appearance="subtle" disabled={index === 0} icon={<ChevronLeftRegular />} onClick={() => setIndex(index - 1)} />
        <Text>{t('requests.pipeline.frame', { index: index + 1, count: stream.frames.length })}</Text>
        <Button aria-label={t('requests.pipeline.nextFrame')} appearance="subtle" disabled={index === stream.frames.length - 1} icon={<ChevronRightRegular />} onClick={() => setIndex(index + 1)} />
      </div>
      <ResultValue key={index} result={frame} select={select} />
    </> : <Text>{t('requests.pipeline.noFrames')}</Text>}
  </>;
}

type View = 'stages' | 'streams' | 'deferreds';

export function PipelineViewer({ dump, onDownload }: { dump: DecodedDump; onDownload: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('stages');
  const [stageId, setStageId] = useState(dump.rootStageIds[0]!);
  const [streamId, setStreamId] = useState(dump.streams.keys().next().value);
  const [deferredId, setDeferredId] = useState(dump.deferreds.keys().next().value);
  const select: SelectTarget = ({ type, id }) => {
    setView(type);
    if (type === 'streams') setStreamId(id);
    else setDeferredId(id);
  };
  const activeStage = dump.stages.get(stageId)!;
  const activeStream = streamId === undefined ? undefined : dump.streams.get(streamId);
  const activeDeferred = deferredId === undefined ? undefined : dump.deferreds.get(deferredId);

  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <div className={`${PANEL_BAND_CLASS} flex flex-wrap items-center justify-between gap-2`}>
      <TabList aria-label={t('requests.pipeline.views')} selectedValue={view} onTabSelect={(_, data) => setView(data.value as View)}>
        <Tab value="stages">{t('requests.pipeline.stages')}</Tab>
        {dump.streams.size > 0 && <Tab value="streams">{t('requests.pipeline.streams')}</Tab>}
        {dump.deferreds.size > 0 && <Tab value="deferreds">{t('requests.pipeline.deferreds')}</Tab>}
      </TabList>
      <Button appearance="subtle" icon={<ArrowDownloadRegular />} onClick={onDownload}>{t('requests.exportRecord')}</Button>
    </div>
    <ScrollArea axes="vertical" className="min-h-0 flex-1">
      {view === 'stages' && <div className={`${PANEL_INSET_CLASS} flex flex-wrap ${PANE_GAP_CLASS}`}>
        <Tree aria-label={t('requests.pipeline.stages')} className="min-w-0 grow basis-48" defaultOpenItems={dump.stages.keys()}
          selectionMode="single" checkedItems={[stageId]} onCheckedChange={(_, data) => {
            if (typeof data.value === 'number') setStageId(data.value);
          }}>
          <StageItems dump={dump} ids={dump.rootStageIds} select={setStageId} />
        </Tree>
        <Panel className="min-w-0 grow-[2] basis-72"><StageDetails key={stageId} stage={activeStage} dump={dump} select={select} /></Panel>
      </div>}
      {view === 'streams' && activeStream && <div className={`${PANEL_INSET_CLASS} flex min-w-0 flex-col gap-3`}>
        <Dropdown aria-label={t('requests.pipeline.streams')} selectedOptions={[String(streamId)]} value={t('requests.pipeline.stream', { id: activeStream.streamId })}
          onOptionSelect={(_, data) => setStreamId(Number(data.optionValue))}>
          {[...dump.streams.keys()].map(id => <Option key={id} value={String(id)}>{t('requests.pipeline.stream', { id })}</Option>)}
        </Dropdown>
        <StreamFrames key={streamId} stream={activeStream} select={select} />
      </div>}
      {view === 'deferreds' && activeDeferred && <div className={`${PANEL_INSET_CLASS} flex min-w-0 flex-col gap-3`}>
        <Dropdown aria-label={t('requests.pipeline.deferreds')} selectedOptions={[String(deferredId)]} value={t('requests.pipeline.deferred', { id: activeDeferred.deferredId })}
          onOptionSelect={(_, data) => setDeferredId(Number(data.optionValue))}>
          {[...dump.deferreds.keys()].map(id => <Option key={id} value={String(id)}>{t('requests.pipeline.deferred', { id })}</Option>)}
        </Dropdown>
        {activeDeferred.settlement ? <ResultValue key={deferredId} result={activeDeferred.settlement} select={select} /> : <Text>{t('requests.pipeline.unsettled')}</Text>}
      </div>}
    </ScrollArea>
  </div>;
}
