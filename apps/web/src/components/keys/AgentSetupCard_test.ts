import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';

import { buildRealModel } from '../../api/test-fixtures.ts';
import type { ControlPlaneModel } from '../../api/types.ts';
import type { AgentSetupConfiguration } from '../../composables/useAgentSetup.ts';
import { Combobox, Select } from '@floway-dev/ui';

// The card owns one useAgentSetup instance; the tests drive the card through a
// hand-built stand-in whose refs they mutate per case. useApi is mocked so the
// card never reaches the real Pinia auth store or the network.
interface SetupStub {
  state: {
    initialized: Ref<boolean>;
    token: Ref<string | null>;
    configurationRevision: Ref<number | null>;
    expiresAt: Ref<number | null>;
    scripts: Ref<{ sh: string; ps1: string } | null>;
    noSelectableKey: Ref<boolean>;
    error: Ref<string | null>;
  };
  draft: Ref<AgentSetupConfiguration | null>;
  syncing: Ref<boolean>;
  superseded: Ref<boolean>;
  canCopy: Ref<boolean>;
  save: () => void;
  heartbeat: () => void;
  dispose: () => void;
}

let setupStub: SetupStub;
let selectableIdsArg: readonly string[] | null;

const defaultConfig = (): AgentSetupConfiguration => ({
  apiKeyId: 'key-1',
  claudeCode: {
    enabled: true, model: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, modelDiscovery: true,
  },
  codex: { enabled: true, model: null, reasoningEffort: null },
});

const makeSetup = (over: Partial<{ config: AgentSetupConfiguration; initialized: boolean; scripts: { sh: string; ps1: string } | null; noSelectableKey: boolean; syncing: boolean; superseded: boolean; canCopy: boolean; error: string | null; expiresAt: number | null }> = {}): SetupStub => ({
  state: {
    initialized: ref(over.initialized ?? true),
    token: ref('tok-1'),
    configurationRevision: ref(1),
    expiresAt: ref(over.expiresAt ?? Date.now() + 5 * 60 * 1000),
    scripts: ref(over.scripts ?? { sh: '/api/setup/tok-1/setup.sh', ps1: '/api/setup/tok-1/setup.ps1' }),
    noSelectableKey: ref(over.noSelectableKey ?? false),
    error: ref(over.error ?? null),
  },
  draft: ref(over.config ?? defaultConfig()),
  syncing: ref(over.syncing ?? false),
  superseded: ref(over.superseded ?? false),
  canCopy: ref(over.canCopy ?? true),
  save: vi.fn(),
  heartbeat: vi.fn(),
  dispose: vi.fn(),
});

vi.mock('../../api/client.ts', () => ({ useApi: () => ({}) }));
vi.mock('../../composables/useAgentSetup.ts', () => ({
  useAgentSetup: (_api: unknown, selectableKeyIds: () => readonly string[]) => {
    selectableIdsArg = typeof selectableKeyIds === 'function' ? selectableKeyIds() : selectableKeyIds;
    return setupStub;
  },
}));

const { default: AgentSetupCard } = await import('./AgentSetupCard.vue');

const model = (id: string, over: Partial<ControlPlaneModel> = {}): ControlPlaneModel => buildRealModel({ id, ...over });

const defaultKeys = [{ id: 'key-1', name: 'Primary' }, { id: 'key-2', name: 'CI' }];

const defaultModels: ControlPlaneModel[] = [
  model('gpt-5'),
  model('claude-sonnet-4-5', { limits: { max_context_window_tokens: 1_000_000 } }),
  model('claude-haiku-4-5'),
  model('text-embedding-3', { kind: 'embedding', endpoints: { embeddings: {} } }),
];

const mountCard = (props: Partial<InstanceType<typeof AgentSetupCard>['$props']> = {}) => mount(AgentSetupCard, {
  props: { keys: defaultKeys, models: defaultModels, ...props },
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

beforeEach(() => {
  setupStub = makeSetup();
  selectableIdsArg = null;
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AgentSetupCard', () => {
  it('passes the selectable key ids into useAgentSetup', () => {
    mountCard();
    expect(selectableIdsArg).toEqual(['key-1', 'key-2']);
  });

  it('offers the account keys in the API-key selector by name', () => {
    const w = mountCard();
    const options = selectIn(w, 'agent-setup-api-key').props().options;
    expect(options).toEqual([
      { value: 'key-1', label: 'Primary' },
      { value: 'key-2', label: 'CI' },
    ]);
  });

  it('renders both agent enable switches and the Claude discovery switch', () => {
    const w = mountCard();
    // Reka-UI renders Switch as button[role="switch"]: Claude enabled, Claude
    // discovery, Codex enabled.
    expect(w.findAll('button[role="switch"]').length).toBe(3);
  });

  it('retains every addressable chat model, native-first per family, and skips non-chat models', () => {
    const w = mountCard();
    const claude = selectIn(w, 'claude-model').props().options;
    // A leading "no override" option, then the Claude family ahead of the rest;
    // the embedding model is dropped. The 1M-context Claude id carries the [1m]
    // suffix in its persisted value while the label stays the raw id.
    expect(claude[0]!.label).toContain('Default');
    expect(claude.slice(1).map(o => o.value)).toEqual(['claude-sonnet-4-5[1m]', 'claude-haiku-4-5', 'gpt-5']);

    const codex = selectIn(w, 'codex-model').props().options;
    expect(codex[0]!.label).toContain('Default');
    expect(codex.slice(1).map(o => o.value)).toEqual(['gpt-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);
  });

  it('keeps a persisted model that left the catalog selectable instead of dropping it', () => {
    setupStub = makeSetup({ config: { ...defaultConfig(), codex: { enabled: true, model: 'gpt-5-retired', reasoningEffort: null } } });
    const w = mountCard();
    const codex = selectIn(w, 'codex-model').props().options;
    expect(codex.some(o => o.value === 'gpt-5-retired')).toBe(true);
  });

  it('exposes the Claude reasoning-effort enum with an optional sentinel', () => {
    const w = mountCard();
    const effort = selectIn(w, 'claude-effort').props().options;
    expect(effort[0]!.label).toContain('Default');
    expect(effort.slice(1).map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('offers a free-form Codex effort combobox seeded with upstream-advertised suggestions', () => {
    setupStub = makeSetup({ config: { ...defaultConfig(), codex: { enabled: true, model: 'gpt-5', reasoningEffort: null } } });
    const w = mountCard({
      models: [model('gpt-5', { chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'high' } } } })],
    });
    const combo = w.get('[data-testid="codex-effort"]').findComponent(Combobox);
    expect(combo.props('items')).toEqual(['low', 'high']);
  });

  it('maps a blank Codex effort to null but preserves an opaque non-empty value verbatim', async () => {
    const w = mountCard();
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

  it('disables the Claude sub-controls while the agent is off but keeps their values', () => {
    setupStub = makeSetup({
      config: {
        ...defaultConfig(),
        claudeCode: { enabled: false, model: 'claude-sonnet-4-5', defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: 'high', modelDiscovery: true },
      },
    });
    const w = mountCard();
    expect(selectIn(w, 'claude-model').props().disabled).toBe(true);
    expect(selectIn(w, 'claude-effort').props().disabled).toBe(true);
    // Values survive the disabled state — nothing resets the draft.
    expect(setupStub.draft.value!.claudeCode.model).toBe('claude-sonnet-4-5');
    expect(setupStub.draft.value!.claudeCode.effortLevel).toBe('high');
  });

  it('warns that Codex setup replaces CODEX_HOME/auth.json when Codex is enabled', () => {
    expect(mountCard().text()).toContain('auth.json');
  });

  it('shows a models-loading hint only while the catalog is genuinely empty', () => {
    expect(mountCard({ models: [], loading: true }).text()).toContain('Loading models');
    // With a populated catalog a reload must not flash the hint.
    expect(mountCard({ loading: true }).text()).not.toContain('Loading models');
  });

  it('renders the shell and PowerShell commands built from the origin and the lease script paths', () => {
    const w = mountCard();
    const text = w.text();
    expect(text).toContain(`curl -fsSL ${window.location.origin}/api/setup/tok-1/setup.sh | bash`);
    expect(text).toContain(`irm ${window.location.origin}/api/setup/tok-1/setup.ps1 | iex`);
    // The PowerShell command must not touch Execution Policy.
    expect(text).not.toContain('ExecutionPolicy');
    expect(text).not.toContain('Bypass');
  });

  it('shows a saving indicator and disables both copy buttons while a draft edit is unconfirmed', () => {
    setupStub = makeSetup({ syncing: true, canCopy: false });
    const w = mountCard();
    expect(w.text()).toContain('Saving');
    const buttons = w.findAll('button[aria-label="Copy command"]');
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect((b.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the create-a-key empty state and no commands when there is no selectable key', () => {
    setupStub = makeSetup({ initialized: false, noSelectableKey: true, scripts: null });
    const w = mountCard({ keys: [] });
    expect(w.text()).toContain('API key');
    expect(w.findAll('button[aria-label="Copy command"]').length).toBe(0);
  });

  it('renders a superseded terminal state that tells the user to reload and shows no copy affordance', () => {
    setupStub = makeSetup({ superseded: true, canCopy: false });
    const w = mountCard();
    expect(w.text().toLowerCase()).toContain('reload');
    expect(w.findAll('button[aria-label="Copy command"]').length).toBe(0);
  });

  it('copies exactly the visible shell command through the command button', async () => {
    const w = mountCard();
    const writeText = (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText;
    await w.findAll('button[aria-label="Copy command"]')[0]!.trigger('click');
    await nextTick();
    expect(writeText).toHaveBeenCalledWith(`curl -fsSL ${window.location.origin}/api/setup/tok-1/setup.sh | bash`);
  });

  it('surfaces a synchronization error from the setup composable', () => {
    setupStub = makeSetup({ error: 'bad configuration' });
    expect(mountCard().text()).toContain('bad configuration');
  });
});
