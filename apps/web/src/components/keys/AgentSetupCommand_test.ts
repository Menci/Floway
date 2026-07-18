import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AgentSetupCommand from './AgentSetupCommand.vue';

// A resolvable/rejectable clipboard writer the tests install per case. happy-dom
// ships no clipboard, so every test defines the surface the component touches.
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

const copyButton = (w: ReturnType<typeof mount>, label = 'Shell') => w.find(`button[aria-label="Copy ${label} command"]`);

describe('AgentSetupCommand', () => {
  it('renders the label and exact command with an instance-specific copy name', () => {
    const w = mount(AgentSetupCommand, {
      props: { label: 'macOS / Linux', command: 'curl -fsSL https://x/api/setup/t/claude.sh | bash', language: 'bash' },
    });
    expect(w.text()).toContain('macOS / Linux');
    expect(w.text()).toContain('curl -fsSL https://x/api/setup/t/claude.sh | bash');
    expect(copyButton(w, 'macOS / Linux').exists()).toBe(true);
  });

  it('renders the code block in the requested language', () => {
    const w = mount(AgentSetupCommand, {
      props: { label: 'Windows', command: 'irm https://x/api/setup/t/codex.ps1 | iex', language: 'powershell' },
    });
    expect(copyButton(w, 'Windows').exists()).toBe(true);
    expect(w.find('code.language-powershell').exists()).toBe(true);
  });

  it('copies exactly the visible command to the clipboard and announces success', async () => {
    const command = 'curl -fsSL https://x/api/setup/t/claude.sh | bash';
    const w = mount(AgentSetupCommand, { props: { label: 'Shell', command, language: 'bash' } });

    await copyButton(w).trigger('click');
    await nextTick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(command);
    const status = w.get('[role="status"]');
    expect(status.attributes('aria-live')).toBe('polite');
    expect(status.text()).toBe('Copied');
  });

  it('keeps the copy button rendered but disabled and never writes while disabled', async () => {
    const w = mount(AgentSetupCommand, { props: { label: 'Shell', command: 'irm https://x/api/setup/t/codex.ps1 | iex', language: 'powershell', disabled: true } });

    const button = copyButton(w);
    expect(button.exists()).toBe(true);
    expect((button.element as HTMLButtonElement).disabled).toBe(true);

    // A disabled DOM button drops the click, but the handler also rechecks the
    // gate so a programmatic invocation cannot slip a write past it.
    await button.trigger('click');
    await nextTick();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('catches a clipboard rejection and announces the failure', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const w = mount(AgentSetupCommand, { props: { label: 'Shell', command: 'x', language: 'bash' } });

    await copyButton(w).trigger('click');
    await nextTick();
    await nextTick();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(w.get('[role="status"]').text()).toBe('Copy failed');
  });
});
