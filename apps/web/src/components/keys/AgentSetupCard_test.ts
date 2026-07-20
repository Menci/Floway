import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import type { AgentSetupConfiguration } from '../../composables/useAgentSetup.ts';
import { Combobox, Select, Switch } from '@floway-dev/ui';

// The card owns one useAgentSetup instance; the tests drive the card through a
// hand-built stand-in whose refs they mutate per case. useApi is mocked so the
// card never reaches the real Pinia auth store or the network.
interface SetupStub {
  state: {
    initialized: Ref<boolean>;
    scripts: Ref<{ claude: { sh: string; ps1: string }; codex: { sh: string; ps1: string } } | null>;
    noSelectableKey: Ref<boolean>;
    error: Ref<string | null>;
  };
  draft: Ref<AgentSetupConfiguration | null>;
  syncing: Ref<boolean>;
  terminated: Ref<boolean>;
  canCopy: Ref<boolean>;
  retryCreate: () => void;
}

let setupStub: SetupStub;
let selectableIdsArg: readonly string[] | null;
let activeArg: boolean | null;

const defaultConfig = (): AgentSetupConfiguration => ({
  apiKeyId: 'key-1',
  claudeCode: {
    model: null, defaultOpusModel: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
});

const makeSetup = (over: Partial<{ config: AgentSetupConfiguration; initialized: boolean; scripts: { claude: { sh: string; ps1: string }; codex: { sh: string; ps1: string } } | null; noSelectableKey: boolean; syncing: boolean; terminated: boolean; canCopy: boolean; error: string | null }> = {}): SetupStub => ({
  state: {
    initialized: ref(over.initialized ?? true),
    scripts: ref(over.scripts ?? {
      claude: { sh: '/api/setup/tok-1/claude.sh', ps1: '/api/setup/tok-1/claude.ps1' },
      codex: { sh: '/api/setup/tok-1/codex.sh', ps1: '/api/setup/tok-1/codex.ps1' },
    }),
    noSelectableKey: ref(over.noSelectableKey ?? false),
    error: ref(over.error ?? null),
  },
  draft: ref(over.config ?? defaultConfig()),
  syncing: ref(over.syncing ?? false),
  terminated: ref(over.terminated ?? false),
  canCopy: ref(over.canCopy ?? true),
  retryCreate: vi.fn(),
});

vi.mock('../../api/client.ts', () => ({ useApi: () => ({}) }));
vi.mock('../../composables/useAgentSetup.ts', () => ({
  useAgentSetup: (_api: unknown, selectableKeyIds: () => readonly string[], active: () => boolean) => {
    selectableIdsArg = typeof selectableKeyIds === 'function' ? selectableKeyIds() : selectableKeyIds;
    activeArg = typeof active === 'function' ? active() : active;
    return setupStub;
  },
}));

const { default: AgentSetupCard } = await import('./AgentSetupCard.vue');

const model = (id: string, over: Partial<ControlPlaneModel> = {}): ControlPlaneModel => buildRealModel({ id, ...over });

const defaultKeys: ApiKey[] = [
  { id: 'key-1', name: 'Primary', key: 'first-key', created_at: '2026-01-01T00:00:00Z', last_used_at: null, upstream_ids: null, dump_retention_seconds: null },
  { id: 'key-2', name: 'CI', key: 'second-key', created_at: '2026-01-01T00:00:00Z', last_used_at: null, upstream_ids: null, dump_retention_seconds: null },
];

const defaultModels: ControlPlaneModel[] = [
  model('gpt-5'),
  model('claude-fable-4-6'),
  model('claude-opus-4-8'),
  model('claude-sonnet-4-5', { limits: { max_context_window_tokens: 1_000_000 } }),
  model('claude-haiku-4-5'),
  model('text-embedding-3', { kind: 'embedding', endpoints: { embeddings: {} } }),
];

const mountCard = (props: Partial<InstanceType<typeof AgentSetupCard>['$props']> = {}) => mount(AgentSetupCard, {
  props: { selectedKey: defaultKeys[0], models: defaultModels, ...props },
});

// Select is a generic SFC whose type args don't flow through findComponent's
// overloads, so the wrapper is read through a small structural probe (the same
// idiom the alias-target-row tests use for casting Select wrappers).
interface SelectProbe {
  props(): { options: { value: string; label: string }[]; modelValue: string; disabled: boolean };
  vm: { $emit: (event: string, ...args: unknown[]) => void };
}
const selectIn = (w: ReturnType<typeof mountCard>, testid: string): SelectProbe =>
  w.get(`[data-testid="${testid}"]`).findComponent(Select) as unknown as SelectProbe;
const selectAgent = async (w: ReturnType<typeof mountCard>, label: 'Claude Code' | 'Codex') => {
  const button = w.findAll('nav[aria-label="Agent"] button').find(item => item.text() === label);
  if (!button) throw new Error(`Missing ${label} agent item`);
  await button.trigger('click');
};

beforeEach(() => {
  setupStub = makeSetup();
  selectableIdsArg = null;
  activeArg = null;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AgentSetupCard', () => {
  it('passes the selectable key ids into useAgentSetup', () => {
    mountCard();
    expect(selectableIdsArg).toEqual(['key-1']);
    expect(activeArg).toBe(true);
  });

  it('switches only the output while preserving the same configuration controls', async () => {
    const w = mountCard();
    const modeTabs = w.findAll('[role="tablist"][aria-label="Agent configuration mode"] [role="tab"]');
    expect(modeTabs.map(tab => [tab.text(), tab.attributes('aria-selected')])).toEqual([
      ['Agent Setup', 'true'],
      ['Config snippets', 'false'],
    ]);
    expect(w.text()).toContain('The configuration below will use the Primary API key.');
    expect(w.get('p span.font-medium').classes()).toContain('text-gray-300');
    const fields = w.get('[data-testid="claude-fields"]').element;

    await modeTabs[1]!.trigger('click');
    expect(w.get('[data-testid="claude-fields"]').element).toBe(fields);
    expect(w.text()).toContain('Edit ~/.claude/settings.json and merge this JSON object');
    await selectAgent(w, 'Codex');
    expect(w.find('[data-testid="claude-fields"]').exists()).toBe(false);
    expect(w.find('[data-testid="codex-fields"]').exists()).toBe(true);
    expect(w.text()).toContain('Merge into ~/.codex/config.toml');
    expect(w.text()).not.toContain('Edit ~/.claude/settings.json');
  });

  it('drives a manual Codex snippet from the shared model and effort controls', async () => {
    const w = mountCard();
    const modeTabs = w.findAll('[role="tablist"][aria-label="Agent configuration mode"] [role="tab"]');
    await modeTabs[1]!.trigger('click');
    await selectAgent(w, 'Codex');

    selectIn(w, 'codex-model').vm.$emit('update:modelValue', 'gpt-5');
    w.get('[data-testid="codex-effort"]').findComponent(Combobox).vm.$emit('update:modelValue', 'xhigh');
    await nextTick();

    const config = w.get('code.language-toml').text();
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('model_reasoning_effort = "xhigh"');
  });

  it('associates visible labels with representative Select and Combobox controls', async () => {
    const w = mountCard();
    const claudeModelField = w.get('[data-testid="claude-model"]');
    expect(claudeModelField.get('label').attributes('for')).toBe(claudeModelField.get('button[role="combobox"]').attributes('id'));
    await selectAgent(w, 'Codex');
    const codexEffortField = w.get('[data-testid="codex-effort"]');
    expect(codexEffortField.get('label').attributes('for')).toBe(codexEffortField.get('input').attributes('id'));
  });

  it('starts the two new Claude preferences on a new row in the unchanged field grid', async () => {
    const w = mountCard();
    const fields = w.get('[data-testid="claude-fields"]');
    expect(fields.classes()).toContain('xl:grid-cols-5');
    expect([...fields.element.children].map(element => element.getAttribute('data-testid'))).toEqual([
      'claude-model',
      'claude-opus',
      'claude-sonnet',
      'claude-haiku',
      'claude-effort',
      'claude-model-discovery',
      'claude-cleanup-period',
      'claude-attribution-opt-out',
    ]);
    expect(w.get('[data-testid="claude-cleanup-period"]').classes()).toContain('sm:col-start-1');

    const discovery = w.get('[data-testid="claude-model-discovery"]');
    expect(discovery.text()).toContain('Gateway model discovery');
    expect(discovery.text()).toContain('Enabled');
    expect(discovery.get('div').classes()).toContain('h-9');
    expect(discovery.get('div').classes()).not.toContain('border');
    await selectAgent(w, 'Codex');
    expect(w.get('[data-testid="codex-fields"]').classes()).toEqual(fields.classes());
  });

  it('moves a restored lease onto the API key selected by the table', async () => {
    mountCard({ selectedKey: defaultKeys[1] });
    await nextTick();
    expect(setupStub.draft.value!.apiKeyId).toBe('key-2');
  });

  it('uses Iconify logos and only renders the selected agent pane', async () => {
    const w = mountCard();
    expect(w.find('.i-simple-icons-anthropic').exists()).toBe(true);
    expect(w.find('.i-simple-icons-openai').exists()).toBe(true);
    expect(w.find('button[role="switch"][aria-label="Enable Claude Code gateway model discovery"]').exists()).toBe(true);
    expect(w.find('[data-testid="codex-fields"]').exists()).toBe(false);
    await selectAgent(w, 'Codex');
    expect(w.find('[data-testid="claude-fields"]').exists()).toBe(false);
    expect(w.find('[data-testid="codex-fields"]').exists()).toBe(true);
  });

  it('retains every addressable chat model, native-first per family, and skips non-chat models', async () => {
    const w = mountCard();
    const claude = selectIn(w, 'claude-model').props().options;
    // A leading "no override" option, then the Claude family ahead of the rest;
    // the embedding model is dropped. The 1M-context Claude id carries the [1m]
    // suffix in its persisted value while the label stays the raw id.
    expect(claude[0]!.label).toBe('Default');
    expect(claude.slice(1).map(o => o.value)).toEqual(['claude-fable-4-6', 'claude-opus-4-8', 'claude-sonnet-4-5[1m]', 'claude-haiku-4-5', 'gpt-5']);

    const opus = selectIn(w, 'claude-opus').props().options;
    expect(opus.slice(1).map(o => o.value)).toEqual(['claude-opus-4-8', 'claude-fable-4-6', 'claude-sonnet-4-5[1m]', 'claude-haiku-4-5', 'gpt-5']);

    await selectAgent(w, 'Codex');
    const codex = selectIn(w, 'codex-model').props().options;
    expect(codex[0]!.label).toBe('Default');
    expect(codex.slice(1).map(o => o.value)).toEqual(['gpt-5', 'claude-fable-4-6', 'claude-opus-4-8', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
  });

  it('keeps a persisted model that left the catalog selectable instead of dropping it', async () => {
    setupStub = makeSetup({ config: { ...defaultConfig(), codex: { model: 'gpt-5-retired', reasoningEffort: null } } });
    const w = mountCard();
    await selectAgent(w, 'Codex');
    const codex = selectIn(w, 'codex-model').props().options;
    expect(codex.some(o => o.value === 'gpt-5-retired')).toBe(true);
  });

  it('exposes the Claude reasoning-effort enum with an optional sentinel', () => {
    const w = mountCard();
    const effort = selectIn(w, 'claude-effort').props().options;
    expect(effort[0]!.label).toBe('Default');
    expect(effort.slice(1).map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('offers the supported Claude cleanup periods with Default omitting the setting', async () => {
    const w = mountCard();
    const cleanup = selectIn(w, 'claude-cleanup-period');
    expect(cleanup.props().options.map(option => option.label)).toEqual(['Default', '180 days', '365 days', '99999 days']);

    cleanup.vm.$emit('update:modelValue', '365');
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.cleanupPeriodDays).toBe(365);

    cleanup.vm.$emit('update:modelValue', cleanup.props().options[0]!.value);
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.cleanupPeriodDays).toBeNull();
  });

  it('toggles the Claude AI attribution opt-out from the shared configuration', async () => {
    const w = mountCard();
    const attribution = w.get('[data-testid="claude-attribution-opt-out"]');
    expect(attribution.text()).toContain('Disabled');

    attribution.findComponent(Switch).vm.$emit('update:modelValue', true);
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.optOutAiAttribution).toBe(true);
    expect(attribution.text()).toContain('Enabled');
  });

  it('offers a free-form Codex effort combobox seeded with upstream-advertised suggestions', async () => {
    setupStub = makeSetup({ config: { ...defaultConfig(), codex: { model: 'gpt-5', reasoningEffort: null } } });
    const w = mountCard({
      models: [model('gpt-5', { chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } } })],
    });
    await selectAgent(w, 'Codex');
    const combo = w.get('[data-testid="codex-effort"]').findComponent(Combobox);
    expect(combo.props('items')).toEqual(['low', 'high']);
  });

  it('maps a blank Codex effort to null but preserves an opaque non-empty value verbatim', async () => {
    const w = mountCard();
    await selectAgent(w, 'Codex');
    const combo = w.get('[data-testid="codex-effort"]').findComponent(Combobox);

    combo.vm.$emit('update:modelValue', 'ultra');
    await nextTick();
    expect(setupStub.draft.value!.codex.reasoningEffort).toBe('ultra');

    combo.vm.$emit('update:modelValue', '');
    await nextTick();
    expect(setupStub.draft.value!.codex.reasoningEffort).toBeNull();
  });

  it('binds an unset Claude model select to the sentinel and writes null back through it', async () => {
    const w = mountCard();
    const claude = selectIn(w, 'claude-model');
    // The "no override" option carries a non-empty sentinel value (Reka Select
    // rejects the empty string), so an unset draft binds to that sentinel.
    const sentinel = claude.props().options[0]!.value;
    expect(sentinel).not.toBe('');
    expect(claude.props().modelValue).toBe(sentinel);

    claude.vm.$emit('update:modelValue', 'claude-sonnet-4-5[1m]');
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.model).toBe('claude-sonnet-4-5[1m]');

    claude.vm.$emit('update:modelValue', sentinel);
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.model).toBeNull();
  });

  it('explains that Codex provider auth stays separate from the official account', async () => {
    const w = mountCard();
    await selectAgent(w, 'Codex');
    const text = w.text();
    expect(text).toContain('provider token is stored separately');
    expect(text).toContain('official Codex account login remains available');
  });

  it('shows a models-loading hint only while the catalog is genuinely empty', () => {
    expect(mountCard({ models: [], loading: true }).text()).toContain('Loading models');
    // With a populated catalog a reload must not flash the hint.
    expect(mountCard({ loading: true }).text()).not.toContain('Loading models');
  });

  it('shows one OS-tab-selected command at a time and places the explanation below it', async () => {
    const w = mountCard();
    const platformTabs = w.findAll('[role="tablist"][aria-label="Setup command platform"] [role="tab"]');
    expect(platformTabs.map(tab => [tab.text(), tab.attributes('aria-selected')])).toEqual([
      ['macOS / Linux', 'true'],
      ['Windows', 'false'],
    ]);
    expect(w.text()).toContain(`export SETUP_ENDPOINT='${window.location.origin}'; curl -fsSL "$SETUP_ENDPOINT/api/setup/tok-1/claude.sh" | bash`);
    const unixCopy = w.get('button[aria-label="Copy macOS / Linux command"]');
    expect(platformTabs[0]!.element.closest('.mb-2')).toBe(unixCopy.element.closest('.mb-2'));
    expect(w.find('button[aria-label="Copy Windows command"]').exists()).toBe(false);

    await platformTabs[1]!.trigger('click');
    expect(w.text()).toContain(`$SetupEndpoint = '${window.location.origin}'; irm "$SetupEndpoint/api/setup/tok-1/claude.ps1" | iex`);
    expect(w.find('button[aria-label="Copy Windows command"]').exists()).toBe(true);
    expect(w.find('code.language-powershell').exists()).toBe(true);
    const explanation = 'This command installs and configures Claude Code.';
    expect(w.text().lastIndexOf(explanation)).toBeGreaterThan(w.text().lastIndexOf('$SetupEndpoint'));
    expect(w.text()).not.toContain('ExecutionPolicy');
    expect(w.text()).not.toContain('Bypass');
  });

  it('keeps one lease token while switching to the other agent-specific script', async () => {
    const w = mountCard();
    expect(w.text()).toContain('/api/setup/tok-1/claude.sh');
    await selectAgent(w, 'Codex');
    expect(w.text()).toContain('/api/setup/tok-1/codex.sh');
    expect(w.text()).not.toContain('/api/setup/tok-1/claude.sh');
  });

  it('defaults the command tab to Windows for Windows clients', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    try {
      const w = mountCard();
      const tabs = w.findAll('[role="tablist"][aria-label="Setup command platform"] [role="tab"]');
      expect(tabs[1]!.attributes('aria-selected')).toBe('true');
      expect(w.find('button[aria-label="Copy Windows command"]').exists()).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('shows a saving indicator and disables both copy buttons while a draft edit is unconfirmed', () => {
    setupStub = makeSetup({ syncing: true, canCopy: false });
    const w = mountCard();
    expect(w.text()).toContain('Saving');
    const buttons = w.findAll('button[aria-label^="Copy "][aria-label$=" command"]');
    expect(buttons.length).toBe(1);
    for (const b of buttons) expect((b.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates no URL before an API key is selected', () => {
    setupStub = makeSetup({ initialized: false, scripts: null });
    const w = mountCard({ selectedKey: null });
    expect(selectableIdsArg).toEqual([]);
    expect(activeArg).toBe(false);
    expect(w.text()).toContain('Select the API key to use.');
    expect(w.find('[data-testid="claude-fields"]').exists()).toBe(true);
    expect(w.text()).toContain('# Select an API key above to generate the setup command.');
    const copy = w.get('button[aria-label="Copy macOS / Linux command"]');
    expect((copy.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.text()).not.toContain('/api/setup/');
  });

  it('keeps keyless form edits local and applies them when a key is selected', async () => {
    const w = mountCard({ selectedKey: null });
    const localModel = selectIn(w, 'claude-model');
    localModel.vm.$emit('update:modelValue', 'claude-opus-4-8');
    await nextTick();
    expect(localModel.props().modelValue).toBe('claude-opus-4-8');
    expect(setupStub.draft.value!.claudeCode.model).toBeNull();

    await w.setProps({ selectedKey: defaultKeys[0] });
    await nextTick();
    expect(setupStub.draft.value!.claudeCode.model).toBe('claude-opus-4-8');
  });

  it('transfers only fields edited before key selection into a restored server draft', async () => {
    const restored = defaultConfig();
    restored.claudeCode.defaultOpusModel = 'claude-opus-restored';
    restored.codex.model = 'gpt-5-restored';
    restored.codex.reasoningEffort = 'high';
    setupStub = makeSetup({ config: restored });

    const w = mountCard({ selectedKey: null });
    selectIn(w, 'claude-model').vm.$emit('update:modelValue', 'claude-sonnet-4-5[1m]');
    await nextTick();
    await w.setProps({ selectedKey: defaultKeys[0] });
    await nextTick();

    expect(setupStub.draft.value).toEqual({
      ...restored,
      claudeCode: { ...restored.claudeCode, model: 'claude-sonnet-4-5[1m]' },
    });
  });

  it('renders a terminated terminal state and keeps the disabled command visible', () => {
    setupStub = makeSetup({ terminated: true, canCopy: false });
    const w = mountCard();
    expect(w.text().toLowerCase()).toContain('reload');
    expect((w.get('button[aria-label="Copy macOS / Linux command"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('copies exactly the visible shell command through the command button', async () => {
    const w = mountCard();
    const writeText = (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
    await w.findAll('button[aria-label^="Copy "][aria-label$=" command"]')[0]!.trigger('click');
    await nextTick();
    expect(writeText).toHaveBeenCalledWith(`export SETUP_ENDPOINT='${window.location.origin}'; curl -fsSL "$SETUP_ENDPOINT/api/setup/tok-1/claude.sh" | bash`);
  });

  it('surfaces a synchronization error from the setup composable', () => {
    setupStub = makeSetup({ error: 'bad configuration' });
    expect(mountCard().text()).toContain('bad configuration');
  });

  it('renders a create failure once with a Retry action instead of an endless spinner', async () => {
    setupStub = makeSetup({ initialized: false, error: 'server exploded', scripts: null });
    const w = mountCard();
    const banner = w.get('[data-testid="agent-setup-create-error"]');
    expect(banner.text()).toContain('server exploded');
    expect(w.text().match(/server exploded/g)).toHaveLength(1);
    // No "Preparing" spinner state while an error is shown.
    expect(w.text()).not.toContain('Preparing setup');

    const retry = banner.get('button');
    await retry.trigger('click');
    expect(setupStub.retryCreate).toHaveBeenCalledTimes(1);
  });
});
