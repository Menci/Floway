import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ChevronDownRegular,
  DeleteRegular,
  EditRegular,
  PlugConnectedRegular,
  SaveRegular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';

import type { AuthUser } from '../api/auth';
import type { UpstreamRecord } from '../api/types';
import { Sidebar } from '../components/sidebar/nav';
import type { UpstreamEditorValues } from '../components/upstream-editor/data';
import { valuesFromRecord } from '../components/upstream-editor/data';
import { CopilotQuotaCard } from '../components/upstream-editor/copilot-quota-card';
import { EditorSection } from '../components/upstream-editor/section';
import { UpstreamWorkspace } from '../components/upstream-editor/workspace';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Combobox, Input, Switch } from '../components/ui/fluent-form-controls';
import { PANE_GAP_CLASS } from '../components/ui/layout';
import { Panel, PANEL_INSET_CLASS } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { TableActions, TableCentredCell, TableCentredHeader, TableTrailingHeader } from '../components/ui/table-actions';
import { TableColumns } from '../components/ui/table-columns';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { HuePicker } from '../components/upstreams/hue-picker';
import { ProviderBadge, ProviderIcon } from '../components/upstreams/provider-badge';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const {
  Button,
  Card,
  Field,
  Link,
  Menu,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} = fluentComponents;

type MockView = 'github' | 'ghe' | 'waiting' | 'connected' | 'list';

const user: AuthUser = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };

const emptyRecord = (): Extract<UpstreamRecord, { kind: 'copilot' }> => ({
  id: '',
  name: 'Copilot (work)',
  enabled: true,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  kind: 'copilot',
  hue: 225,
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: { prefix: 'copilot/', addressable: ['prefixed'], listed: 'prefixed' },
  modelsCache: { fetchedAt: null, lastError: null },
  config: {
    githubToken: '',
    user: { login: '', avatar_url: '', name: null, id: 0 },
  },
  state: null,
});

const connectedRecord = (host: string): Extract<UpstreamRecord, { kind: 'copilot' }> => ({
  ...emptyRecord(),
  id: 'copilot-work',
  created_at: '2026-08-05T06:00:00.000Z',
  updated_at: '2026-08-05T06:00:00.000Z',
  modelsCache: { fetchedAt: Date.now() - 45_000, lastError: null },
  config: {
    githubTokenSet: true,
    user: { login: 'alexm', avatar_url: '', name: 'Alex Morgan', id: 101 },
  },
  state: {
    copilotToken: { baseUrl: `https://api.${host}` },
    quotaSnapshot: null,
  },
});

function AccountSummary({ host }: { host: string }) {
  return <div className="flex items-center gap-3 min-w-0">
    <ProviderIcon kind="copilot" className="h-8 w-8" />
    <div className="grid gap-0.5 min-w-0">
      <Text weight="semibold" truncate wrap={false}>Alex Morgan</Text>
      <Text className="text-fui-fg2" size={200}>{host}/alexm</Text>
    </div>
  </div>;
}

function Connection({ host, onHostChange, onViewChange, view }: {
  host: string;
  onHostChange: (host: string) => void;
  onViewChange: (view: MockView) => void;
  view: MockView;
}) {
  const locked = view === 'waiting' || view === 'connected';
  return <div className="grid gap-3">
    <Field
      hint="Choose a host or enter any GitHub hostname."
      label="GitHub host"
    >
      <Combobox
        className="font-mono"
        freeform
        onChange={(_, data) => onHostChange(data.value)}
        onOptionSelect={(_, data) => onHostChange(data.optionValue ?? '')}
        readOnly={locked}
        selectedOptions={host === 'github.com' ? ['github.com'] : []}
        value={host}
      >
        <Option text="github.com" value="github.com">github.com</Option>
      </Combobox>
    </Field>

    {view === 'connected'
      ? <div className="grid gap-3">
          <AccountSummary host={host} />
          <CopilotQuotaCard record={connectedRecord(host)} />
        </div>
      : view === 'waiting'
        ? <div className="grid gap-2">
            <Text className="text-fui-fg2" size={300}>
              Connect the Copilot subscription assigned to your {host} account.
            </Text>
            <Text className="text-fui-fg2" size={200}>Device code</Text>
            <code className="mono-display tracking-[0.25em] text-fui-fg1">B7F2-E91C</code>
            <Link href={`https://${host}/login/device`} target="_blank" rel="noopener noreferrer">
              {`https://${host}/login/device`}
            </Link>
            <Spinner label="Waiting for authorization…" labelPosition="after" size="tiny" />
          </div>
        : <>
            <Text className="text-fui-fg2" size={300}>
              Connect the Copilot subscription assigned to your {host} account.
            </Text>
            <Button
              appearance="primary"
              icon={<PlugConnectedRegular />}
              onClick={() => onViewChange('waiting')}
            >
              Connect GitHub
            </Button>
          </>}
  </div>;
}

function EditorMock({ host, onHostChange, onViewChange, view }: {
  host: string;
  onHostChange: (host: string) => void;
  onViewChange: (view: MockView) => void;
  view: MockView;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('Copilot (work)');
  const [hue, setHue] = useState(225);
  const record = view === 'connected' ? connectedRecord(host) : emptyRecord();
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });

  return <FormProvider {...form}>
    <div className="flex flex-col gap-[14px] h-full min-h-0">
      <header className="flex items-center gap-3 min-w-0">
        <Button appearance="subtle" icon={<span aria-hidden="true">←</span>}>{t('dashboard.upstreamEditor.actions.back')}</Button>
        {view !== 'connected' && <Text className="text-fui-fg2" size={200}>{t('dashboard.upstreamEditor.unsaved')}</Text>}
        <div className="ml-auto flex items-center gap-2">
          <Button appearance="primary" icon={<SaveRegular />}>{t('dashboard.upstreamEditor.actions.save')}</Button>
        </div>
      </header>

      <div className={`grid grid-cols-[380px_minmax(0,1fr)] ${PANE_GAP_CLASS} min-h-0 min-w-0 flex-1 max-[1050px]:grid-cols-1`}>
        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <ScrollArea axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" noTabIndex viewportClassName="scroll-py-1">
            <div className={PANEL_INSET_CLASS}>
              <aside className="grid gap-7">
                <EditorSection title={t('dashboard.upstreamEditor.fields.name')}>
                  <Field>
                    <Input aria-label={t('dashboard.upstreamEditor.fields.name')} onChange={(_, data) => setName(data.value)} value={name} />
                  </Field>
                </EditorSection>

                <EditorSection
                  inline
                  title={t('dashboard.upstreamEditor.sections.hue')}
                  description={t('dashboard.upstreamEditor.hue.description')}
                >
                  <HuePicker hue={hue} kind="copilot" onChange={setHue} />
                </EditorSection>

                <EditorSection title={t('dashboard.upstreamEditor.sections.connection')}>
                  <Connection host={host} onHostChange={onHostChange} onViewChange={onViewChange} view={view} />
                </EditorSection>

                <EditorSection title={t('dashboard.upstreamEditor.sections.proxy')} description={t('dashboard.upstreamEditor.proxy.empty')}>
                  <Button icon={<span aria-hidden="true">＋</span>}>{t('dashboard.upstreamEditor.proxy.add')}</Button>
                </EditorSection>

                <EditorSection title={t('dashboard.upstreamEditor.sections.prefix')} description={t('dashboard.upstreamEditor.prefixDescription')}>
                  <Input className="font-mono" value="copilot/" readOnly />
                </EditorSection>

                <EditorSection title={t('dashboard.upstreamEditor.sections.disabledModels')} description={t('dashboard.upstreamEditor.disabledModelsHint')}>
                  <Combobox placeholder={t('dashboard.upstreamEditor.disabledModelsPlaceholder')} readOnly value="" />
                </EditorSection>
              </aside>
            </div>
          </ScrollArea>
        </Panel>

        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <UpstreamWorkspace
            discovered={[]}
            modelsError={null}
            modelsLoading={false}
            onRefreshModels={() => {}}
            record={record}
          />
        </Panel>
      </div>
    </div>
  </FormProvider>;
}

const providerKinds = ['custom', 'azure', 'copilot', 'codex', 'claude-code', 'ollama'] as const;

function NewUpstreamMenu() {
  const { t } = useTranslation();
  return <Menu open positioning={{ autoSize: true }}>
    <MenuTrigger disableButtonEnhancement>
      <Button appearance="primary" icon={<span aria-hidden="true">＋</span>}>
        {t('dashboard.upstreams.actions.create')}<ChevronDownRegular className="ml-1.5" />
      </Button>
    </MenuTrigger>
    <MenuPopover>
      <MenuList>
        {providerKinds.map(kind => <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 px-3 py-2" key={kind}>
          <ProviderIcon kind={kind} className="h-5 w-5 row-span-2" />
          <Text>{t(`provider.${kind}`)}</Text>
          <Text className="text-fui-fg3" size={200}>{t(`dashboard.upstreams.providers.${kind}`)}</Text>
        </div>)}
      </MenuList>
    </MenuPopover>
  </Menu>;
}

function ListMock() {
  const { t } = useTranslation();
  const rows = useMemo(() => [
    { name: 'Copilot (personal)', login: 'alexm', host: 'github.com', hue: 225, count: 14 },
    { name: 'Copilot (work)', login: 'alexm', host: 'octocorp.ghe.com', hue: 315, count: 12 },
  ], []);
  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions
        createLabel={t('dashboard.upstreams.actions.create')}
        createTrailingIcon={<ChevronDownRegular className="ml-1.5" />}
        createTrigger={() => <NewUpstreamMenu />}
        onRefresh={() => {}}
        refreshLabel={t('dashboard.upstreams.actions.refresh')}
        refreshing={false}
      />}
      description={t('dashboard.pages.upstreams')}
      title={t('dashboard.nav.upstreams')}
    />
    <ResourceListPanel rowHeight="56px">
      <ScrollArea axes="horizontal" className="min-w-0">
        <Table aria-label={t('dashboard.upstreams.table.title')} className="min-w-[900px]">
          <TableColumns widths={['120px', '140px', '300px', '140px', '90px', '92px']} />
          <TableHeader><TableRow>
            <TableHeaderCell>{t('dashboard.upstreams.table.priority')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.provider')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.upstreams.table.models')}</TableHeaderCell>
            <TableCentredHeader>{t('dashboard.upstreams.table.enabled')}</TableCentredHeader>
            <TableTrailingHeader>{t('dashboard.upstreams.table.actions')}</TableTrailingHeader>
          </TableRow></TableHeader>
          <TableBody>{rows.map((row, index) => <TableRow key={row.name}>
            <TableCell><Text className="text-fui-fg3 min-w-[22px] text-center">{index + 1}</Text></TableCell>
            <TableCell><ProviderBadge upstream={{ kind: 'copilot', hue: row.hue }} /></TableCell>
            <TableCell className="overflow-hidden">
              <TableCellLayout
                description={<Text className="text-fui-fg2" size={200}>{row.host}/{row.login}</Text>}
                truncate
              >
                <Text weight="semibold">{row.name}</Text>
              </TableCellLayout>
            </TableCell>
            <TableCell><span className="inline-flex items-center gap-1.5"><CheckmarkCircleRegular className="text-[var(--colorPaletteGreenForeground1)]" fontSize={18} /><Text>{row.count} models</Text></span></TableCell>
            <TableCentredCell><Switch aria-label={`Toggle ${row.name}`} checked /></TableCentredCell>
            <TableCell><TableActions>
              <TooltipIconButton icon={<EditRegular />} label={`Edit upstream ${row.name}`} />
              <TooltipIconButton danger icon={<DeleteRegular />} label={`Delete upstream ${row.name}`} />
            </TableActions></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </ScrollArea>
    </ResourceListPanel>
  </section>;
}

function ReviewControls({ onChange, view }: { onChange: (view: MockView) => void; view: MockView }) {
  const entries: readonly [MockView, string][] = [
    ['github', 'GitHub.com'],
    ['ghe', 'GHE'],
    ['waiting', 'Waiting'],
    ['connected', 'Connected'],
    ['list', 'Upstream list'],
  ];
  return <Card className="!fixed !z-[100000] !bottom-4 !right-4 !p-2 !flex-row !gap-1 shadow-lg">
    {entries.map(([value, label]) => <Button
      appearance={view === value ? 'primary' : 'subtle'}
      key={value}
      onClick={() => onChange(value)}
      size="small"
    >{label}</Button>)}
  </Card>;
}

export default function CopilotGheMockRoute() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('view');
  const view: MockView = selected === 'ghe' || selected === 'waiting' || selected === 'connected' || selected === 'list'
    ? selected
    : 'github';
  const [host, setHost] = useState(view === 'github' ? 'github.com' : 'octocorp.ghe.com');
  const changeView = (next: MockView) => {
    if (next === 'github') setHost('github.com');
    if (next === 'ghe' || next === 'waiting' || next === 'connected') setHost('octocorp.ghe.com');
    setParams(next === 'github' ? {} : { view: next }, { replace: true });
  };
  return <>
    <ReviewControls onChange={changeView} view={view} />
    <div className="grid grid-cols-[clamp(240px,18vw,290px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] h-[100dvh] min-h-0">
      <div className="min-h-0"><Sidebar user={user} /></div>
      <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] min-h-0">
        <main className="min-h-0 p-[22px_var(--floway-page-inset)_var(--floway-page-inset)]">
          {view === 'list'
            ? <ListMock />
            : <EditorMock host={host} onHostChange={setHost} onViewChange={changeView} view={view} />}
        </main>
      </div>
    </div>
  </>;
}
