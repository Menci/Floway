import { useMemo, useState, type ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { encodeWebBase64 } from '../../lib/base-encoding';
import { EmptyStateLine } from '../ui/empty-state';
import { PANEL_INSET_CLASS } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import {
  DeferredReference,
  diffRequestFacts,
  isDumpArray,
  isDumpFacts,
  RawNumber,
  SecretDescription,
  StreamReference,
  type DumpArchive,
  type DumpFacts,
  type DumpStage,
  type DumpValue,
} from '@floway-dev/dump/browser';

const { Button, Text } = fluentComponents;
type Selection = { kind: 'stage' | 'stream' | 'deferred'; id: number };
type Select = (selection: Selection) => void;

function ArchiveSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2">
    <Text as="h3" weight="semibold" size={300}>{title}</Text>
    {children}
  </section>;
}

function ObjectValue({ value, select, ancestors, openByDefault }: {
  value: DumpFacts | readonly DumpValue[];
  select: Select;
  ancestors: readonly object[];
  openByDefault: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(openByDefault);
  if (ancestors.includes(value)) return <span className="text-fui-fg3">{t('requests.archive.circular')}</span>;
  const array = isDumpArray(value);
  const count = array ? value.length : Object.keys(value).length;
  if (count === 0) return <code>{array ? '[]' : '{}'}</code>;
  const parents = [...ancestors, value];
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-fui-fg3">{t(array ? 'requests.archive.array' : 'requests.archive.object', { count })}</summary>
    {open && <dl className="ms-2 my-1 ps-3 border-s border-[var(--winui-divider-stroke-default)]">
      {Object.entries(value).map(([key, item]: [string, DumpValue]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-x-3 py-1">
        <dt className="font-mono break-all text-fui-fg3">{key === '' ? JSON.stringify(key) : key}</dt>
        <dd className="min-w-0"><ValueView value={item} select={select} ancestors={parents} /></dd>
      </div>)}
    </dl>}
  </details>;
}

function ByteValue({ value }: { value: Uint8Array }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-fui-fg3">{t('requests.archive.bytes', { count: value.byteLength })}</summary>
    {open && <code className="block break-all select-text">{encodeWebBase64(value)}</code>}
  </details>;
}

function ValueView({ value, select, ancestors = [], openByDefault = false }: {
  value: DumpValue;
  select: Select;
  ancestors?: readonly object[];
  openByDefault?: boolean;
}) {
  const { t } = useTranslation();
  if (value instanceof StreamReference) return <Button size="small" appearance="subtle" onClick={() => select({ kind: 'stream', id: value.streamId })}>{t('requests.archive.stream', { id: value.streamId })}</Button>;
  if (value instanceof DeferredReference) return <Button size="small" appearance="subtle" onClick={() => select({ kind: 'deferred', id: value.deferredId })}>{t('requests.archive.deferred', { id: value.deferredId })}</Button>;
  if (value instanceof SecretDescription) return <code className="break-all">{t('requests.archive.secret', { length: value.length, redacted: value.redacted, hash: value.hash })}</code>;
  if (value instanceof Uint8Array) return <ByteValue value={value} />;
  if (isDumpFacts(value) || isDumpArray(value)) return <ObjectValue value={value} select={select} ancestors={ancestors} openByDefault={openByDefault} />;
  return <code className="whitespace-pre-wrap break-all select-text">{value instanceof RawNumber ? value.rawJSON
    : typeof value === 'string' ? JSON.stringify(value) : Object.is(value, -0) ? '-0' : String(value)}</code>;
}

function StageDetails({ stage, parent, select }: { stage: DumpStage; parent: DumpStage | undefined; select: Select }) {
  const { t } = useTranslation();
  const differences = useMemo(() => parent ? diffRequestFacts(parent.entry.facts, stage.entry.facts) : [], [parent, stage]);
  const { outcome } = stage;
  return <>
    <ArchiveSection title={t('requests.archive.entryFacts')}>
      <ValueView value={stage.entry.facts} select={select} openByDefault />
    </ArchiveSection>
    {parent && <ArchiveSection title={t('requests.archive.handoff')}>
      {differences.length === 0 ? <EmptyStateLine>{t('requests.archive.noChanges')}</EmptyStateLine> : <ul className="space-y-2">
        {differences.map(change => {
          const path = change.path.map(part => `[${JSON.stringify(part)}]`).join('');
          return <li key={path} className="pt-2 border-t border-[var(--winui-divider-stroke-default)]">
            <code className="break-all">{path}</code>
            <div className="mt-1 grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <Text block size={200} className="text-fui-fg3">{t('requests.archive.before')}</Text>
                {'before' in change ? <ValueView value={change.before} select={select} /> : <Text size={200}>{t('requests.archive.absent')}</Text>}
              </div>
              <div className="min-w-0">
                <Text block size={200} className="text-fui-fg3">{t('requests.archive.after')}</Text>
                {'after' in change ? <ValueView value={change.after} select={select} /> : <Text size={200}>{t('requests.archive.absent')}</Text>}
              </div>
            </div>
          </li>;
        })}
      </ul>}
    </ArchiveSection>}
    <ArchiveSection title={t('requests.archive.outcome')}>
      {'error' in outcome ? <Panic value={outcome.error} select={select} /> : <>
        <Text block weight="semibold">{t('requests.archive.returnedFacts')}</Text>
        <ValueView value={outcome.facts} select={select} openByDefault />
      </>}
    </ArchiveSection>
    {stage.logs.length > 0 && <ArchiveSection title={t('requests.archive.logs')}>
      <ol className="space-y-2">
        {stage.logs.map((log, index) => <li key={index} className="pt-2 border-t border-[var(--winui-divider-stroke-default)]">
          <Text block size={200} className="text-fui-fg3">{log['@localetime']} · {log.level} · {log.context}</Text>
          <Text block className="whitespace-pre-wrap break-all">{log.message}</Text>
          <ValueView value={log.fields} select={select} />
          {'error' in log && <ValueView value={log.error} select={select} />}
        </li>)}
      </ol>
    </ArchiveSection>}
  </>;
}

function Panic({ value, select }: { value: DumpValue; select: Select }) {
  const { t } = useTranslation();
  return <>
    <Text weight="semibold" block className="text-[var(--colorPaletteRedForeground1)]">{t('requests.archive.panic')}</Text>
    <ValueView value={value} select={select} openByDefault />
  </>;
}

function SelectionButton({ entry, selected, select, children }: { entry: Selection; selected: Selection; select: Select; children: ReactNode }) {
  const current = entry.kind === selected.kind && entry.id === selected.id;
  return <Button size="small" appearance={current ? 'secondary' : 'subtle'} aria-current={current ? 'true' : undefined}
    className="w-full !justify-start break-all !text-left" onClick={() => select(entry)}>{children}</Button>;
}

function StageBranch({ archive, id, childrenByParent, selected, select }: {
  archive: DumpArchive;
  id: number;
  childrenByParent: ReadonlyMap<number, readonly number[]>;
  selected: Selection;
  select: Select;
}) {
  const { t } = useTranslation();
  const stage = archive.stages.get(id)!;
  const children = childrenByParent.get(id);
  return <li>
    <SelectionButton entry={{ kind: 'stage', id }} selected={selected} select={select}>{t('requests.archive.stage', { name: stage.entry.name, id })}</SelectionButton>
    {children && <ul className="ms-2 ps-2 space-y-0.5 border-s border-[var(--winui-divider-stroke-default)]">
      {children.map(childId => <StageBranch key={childId} archive={archive} id={childId} childrenByParent={childrenByParent} selected={selected} select={select} />)}
    </ul>}
  </li>;
}

function ArchiveSelection({ archive, selected, select }: { archive: DumpArchive; selected: Selection; select: Select }) {
  const { t } = useTranslation();
  const { id } = selected;
  switch (selected.kind) {
  case 'stage': {
    const stage = archive.stages.get(id)!;
    const parent = stage.entry.parentStageId;
    return <StageDetails stage={stage} parent={parent === undefined ? undefined : archive.stages.get(parent)!} select={select} />;
  }
  case 'stream': {
    const { frames, outcome } = archive.streams.get(id)!;
    return <>
      <ArchiveSection title={t('requests.archive.outcome')}>
        {'error' in outcome ? <Panic value={outcome.error} select={select} /> : <Text>{t('requests.archive.ended')}</Text>}
      </ArchiveSection>
      <ArchiveSection title={t('requests.archive.frames', { count: frames.length })}>
        {frames.length === 0 ? <EmptyStateLine>{t('requests.archive.noFrames')}</EmptyStateLine> : <ol className="space-y-2">
          {frames.map((frame, index) => <li key={index} className="pt-2 border-t border-[var(--winui-divider-stroke-default)]">
            <Text block size={200} className="text-fui-fg3">{t(frame.ok ? 'requests.archive.frame' : 'requests.archive.frameError', { index: index + 1 })}</Text>
            <ValueView value={frame.ok ? frame.value : frame.error} select={select} />
          </li>)}
        </ol>}
      </ArchiveSection>
    </>;
  }
  case 'deferred': {
    const { outcome } = archive.deferreds.get(id)!;
    return <ArchiveSection title={t('requests.archive.outcome')}>
      {'error' in outcome ? <Panic value={outcome.error} select={select} /> : <>
        <Text block weight="semibold">{t('requests.archive.resolved')}</Text>
        <ValueView value={outcome.value} select={select} openByDefault />
      </>}
    </ArchiveSection>;
  }
  }
}

export default function PipelineViewer({ archive }: { archive: DumpArchive }) {
  const { t } = useTranslation();
  const [selected, select] = useState<Selection>({ kind: 'stage', id: archive.rootStageId });
  const childrenByParent = useMemo(() => {
    const children = new Map<number, number[]>();
    for (const { entry } of archive.stages.values()) {
      if (entry.parentStageId === undefined) continue;
      const siblings = children.get(entry.parentStageId);
      if (siblings) siblings.push(entry.stageId);
      else children.set(entry.parentStageId, [entry.stageId]);
    }
    return children;
  }, [archive]);
  return <div className="h-full min-h-0 flex flex-col lg:grid lg:grid-cols-[minmax(10rem,1fr)_minmax(0,2.4fr)]">
    <ScrollArea axes="vertical" className="max-h-[36%] border-b border-[var(--winui-divider-stroke-default)] lg:max-h-none lg:border-b-0 lg:border-e">
      <nav aria-label={t('requests.archive.navigation')} className={`${PANEL_INSET_CLASS} space-y-3`}>
        <ArchiveSection title={t('requests.archive.stages')}>
          <ul><StageBranch archive={archive} id={archive.rootStageId} childrenByParent={childrenByParent} selected={selected} select={select} /></ul>
        </ArchiveSection>
        {archive.streams.size > 0 && <ArchiveSection title={t('requests.archive.streams')}>
          <ul className="space-y-0.5">{Array.from(archive.streams.keys(), id => <li key={id}>
            <SelectionButton entry={{ kind: 'stream', id }} selected={selected} select={select}>{t('requests.archive.stream', { id })}</SelectionButton>
          </li>)}</ul>
        </ArchiveSection>}
        {archive.deferreds.size > 0 && <ArchiveSection title={t('requests.archive.deferreds')}>
          <ul className="space-y-0.5">{Array.from(archive.deferreds.keys(), id => <li key={id}>
            <SelectionButton entry={{ kind: 'deferred', id }} selected={selected} select={select}>{t('requests.archive.deferred', { id })}</SelectionButton>
          </li>)}</ul>
        </ArchiveSection>}
      </nav>
    </ScrollArea>
    <ScrollArea key={`${selected.kind}:${selected.id}`} axes="vertical" className="min-h-0 flex-1" contentClassName={`${PANEL_INSET_CLASS} space-y-5`}>
      <ArchiveSelection archive={archive} selected={selected} select={select} />
    </ScrollArea>
  </div>;
}
