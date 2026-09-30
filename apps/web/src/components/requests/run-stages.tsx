import { lazy, Suspense, useMemo, useState } from 'react';

import { RenderedEventList } from './events';
import { readRun, type RunStage } from './run-model';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { Dropdown } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';

const BodyEditor = lazy(() => import('../ui/body-editor'));
const { Option, Spinner, Text, Tree, TreeItem, TreeItemLayout } = fluentComponents;

const StageBranch = ({ stage, select }: { stage: RunStage; select: (id: number) => void }) => <TreeItem value={stage.id} itemType={stage.children.length > 0 ? 'branch' : 'leaf'} onFocus={event => { if (event.target === event.currentTarget) select(stage.id); }}>
  <TreeItemLayout selector={null}>{stage.name} <Text size={100} className="text-fui-fg3">#{stage.id}</Text></TreeItemLayout>
  {stage.children.length > 0 && <Tree>{stage.children.map(child => <StageBranch key={child.id} stage={child} select={select} />)}</Tree>}
</TreeItem>;

export const RunStages = ({ ndjson }: { ndjson: string }) => {
  const { t } = useTranslation();
  const model = useMemo(() => readRun(ndjson), [ndjson]);
  const [selected, setSelected] = useState(model.roots[0]?.id ?? null);
  const [view, setView] = useState('request');
  const [descent, setDescent] = useState(0);
  const labels = {
    request: t('dashboard.requests.requestFacts'), response: t('dashboard.requests.responseFacts'),
    down: t('dashboard.requests.requestChanges'), up: t('dashboard.requests.responseChanges'),
    logs: t('dashboard.requests.stageLogs'),
  };
  const current = model.stages.find(stage => stage.id === selected);
  if (current === undefined) return <EmptyStateLine className="p-4">{t('dashboard.requests.noRunEvents')}</EmptyStateLine>;
  const child = current.children[descent];
  const text = view === 'request' ? model.state(current.request)
    : view === 'response' ? current.response === null ? null : model.state(current.response)
      : view === 'down' ? child === undefined ? [] : model.diff(current.request, child.request)
        : child?.response === null || child === undefined || current.response === null ? [] : model.diff(child.response, current.response);
  const select = (id: number) => { setSelected(id); setDescent(0); };
  const toolbar = <div className="flex flex-wrap items-center gap-2 min-w-0">
    <Dropdown clearable={false} size="small" aria-label={t('dashboard.requests.stageView')} value={labels[view as keyof typeof labels]} selectedOptions={[view]} onOptionSelect={(_, data) => setView(data.optionValue!)}>
      {Object.entries(labels).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
    </Dropdown>
    {(view === 'down' || view === 'up') && current.children.length > 0 && <Dropdown clearable={false} size="small" aria-label={t('dashboard.requests.descent')} selectedOptions={[String(descent)]} value={`#${child!.id} ${child!.name}`} onOptionSelect={(_, data) => setDescent(Number(data.optionValue))}>
      {current.children.map((stage, index) => <Option key={stage.id} value={String(index)} text={`#${stage.id} ${stage.name}`}>#{stage.id} {stage.name}</Option>)}
    </Dropdown>}
  </div>;
  return <div className="h-full min-h-0 flex flex-col lg:flex-row">
    <ScrollArea axes="both" className="min-h-0 h-1/3 lg:h-full lg:w-1/3 shrink-0 border-b lg:border-b-0 lg:border-r border-[var(--winui-divider-stroke-default)]">
      <Tree aria-label={t('dashboard.requests.stages')} selectionMode="single" checkedItems={selected === null ? [] : [selected]} defaultOpenItems={model.stages.map(stage => stage.id)} onNavigation={(_, data) => {
        if (data.type === 'Click') select(Number(data.value));
      }}>
        {model.roots.map(stage => <StageBranch key={stage.id} stage={stage} select={select} />)}
      </Tree>
    </ScrollArea>
    <div className="flex-1 min-w-0 min-h-0">
      {view === 'logs' ? <RenderedEventList
        events={current.logs.map(log => ({ event: log.level, text: JSON.stringify({ ...log, ...(log.fields === undefined ? {} : { fields: model.state(log.fields) }) }, null, 2), parseError: null }))}
        copyText={current.logs.map(log => JSON.stringify({ ...log, ...(log.fields === undefined ? {} : { fields: model.state(log.fields) }) })).join('\n')}
        toolbarStart={toolbar}
      /> : <Suspense fallback={<Spinner />}><BodyEditor text={JSON.stringify(text, null, 2)} json label={current.name} toolbarStart={toolbar} emptyText={t('dashboard.requests.noRunEvents')} /></Suspense>}
    </div>
  </div>;
};
