import { fireEvent, screen } from '@testing-library/react';
import { forwardRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
import type { UpstreamEditLevel, UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { UpstreamWorkspace, type ModelsYamlDraft } from '../../../src/components/upstream-editor/workspace';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import type { UpstreamModelConfig } from '@floway-dev/provider/browser';

vi.mock('../../../src/components/upstream-editor/models-yaml-editor', () => ({
  default: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => (
    <textarea aria-label="YAML models" onChange={event => onChange(event.target.value)} value={value} />
  ),
}));

vi.mock('../../../src/components/ui/scroll-area', () => ({
  ScrollArea: forwardRef<HTMLDivElement, PropsWithChildren>(({ children }, ref) => <div ref={ref}>{children}</div>),
}));

const listed = (id: string): UpstreamModelConfig => ({
  upstreamModelId: id,
  publicModelId: id,
  display_name: id,
  kind: 'chat',
  endpoints: { openaiResponses: {} },
});

const customRecord = upstreamRecord('up_custom', {
  name: 'Test',
  kind: 'custom',
  config: {
    baseUrl: 'https://example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [listed('model-a')],
  },
  state: null,
});

// The provider owns this catalog, so the workspace's structural controls are
// read-only for it while the enable switch is not.
const copilotRecord = upstreamRecord('', {
  name: 'Copilot',
  kind: 'copilot',
  config: {
    githubHost: 'github.com',
    githubToken: '',
    user: { id: 1, login: 'operator', name: null, avatar_url: '' },
  },
  state: null,
});

// Both surfaces of the one `disabled_public_model_ids` field in a single form,
// because the defect was each of them deriving its own read-only flag.
function Harness({ discovered, editLevel, record }: {
  discovered: UpstreamModelConfig[];
  editLevel: UpstreamEditLevel;
  record: UpstreamRecord;
}) {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  const [modelsYamlDraft, setModelsYamlDraft] = useState<ModelsYamlDraft | null>(null);
  return (
    <MemoryRouter>
      <FormProvider {...form}>
        <UpstreamConfigSidebar
          catalogAvailable
          discovered={discovered}
          editLevel={editLevel}
          onPatch={vi.fn()}
          onRefreshModels={vi.fn()}
          proxies={[]}
          record={record}
          runtime={{ kind: 'node', runtimeLocation: 'TEST' }}
        />
        <UpstreamWorkspace
          discovered={discovered}
          editLevel={editLevel}
          modelsLoading={false}
          modelsError={null}
          modelsYamlDraft={modelsYamlDraft}
          onModelsYamlDraftChange={setModelsYamlDraft}
          onRefreshModels={vi.fn()}
          record={record}
        />
      </FormProvider>
    </MemoryRouter>
  );
}

const combobox = () =>
  screen.getByRole<HTMLInputElement>('combobox', { name: i18n.t('dashboard.upstreamEditor.sections.disabledModels') });
const rowSwitch = (name: string) =>
  screen.getAllByRole<HTMLInputElement>('switch').find(node => node.getAttribute('aria-label')?.includes(name))!;
// `readOnly` on these controls is Fluent's own state, distinct from `disabled`:
// the control stays focusable and refuses the change at the source.
const isReadOnly = (control: Element) => control.getAttribute('aria-readonly') === 'true';

describe('disabled model editing parity between the sidebar and the model list', () => {
  it('leaves both surfaces editable for a Full editor of a provider-owned catalog', () => {
    renderInApp(<Harness discovered={[listed('gpt-5')]} editLevel="full" record={copilotRecord} />);

    expect(isReadOnly(rowSwitch('gpt-5'))).toBe(false);
    expect(isReadOnly(combobox())).toBe(false);

    fireEvent.click(rowSwitch('gpt-5'));
    expect(rowSwitch('gpt-5').checked).toBe(false);
  });

  it('leaves both surfaces editable for a models-level editor', () => {
    renderInApp(<Harness discovered={[]} editLevel="models" record={customRecord} />);

    expect(isReadOnly(rowSwitch('model-a'))).toBe(false);
    expect(isReadOnly(combobox())).toBe(false);
  });

  it('leaves both surfaces read-only for an audit-only editor', () => {
    renderInApp(<Harness discovered={[]} editLevel="off" record={customRecord} />);

    const toggle = rowSwitch('model-a');
    expect(isReadOnly(toggle)).toBe(true);
    expect(isReadOnly(combobox())).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
  });
});
