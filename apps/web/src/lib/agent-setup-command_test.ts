import { describe, expect, it } from 'vitest';

import { buildPowerShellSetupCommand, buildShellSetupCommand } from './agent-setup-command.ts';

const SH_PATH = '/api/setup/tok-1/setup.sh';
const PS1_PATH = '/api/setup/tok-1/setup.ps1';

describe('buildShellSetupCommand', () => {
  it('exports the origin, then fetches through the same exported variable', () => {
    expect(buildShellSetupCommand('https://gateway.example', SH_PATH))
      .toBe(`export FLOWAY_BASE_URL='https://gateway.example'; curl -fsSL "$FLOWAY_BASE_URL${SH_PATH}" | bash`);
  });

  it('keeps a port in the origin and appends the relative path once', () => {
    expect(buildShellSetupCommand('http://localhost:8788', SH_PATH))
      .toBe(`export FLOWAY_BASE_URL='http://localhost:8788'; curl -fsSL "$FLOWAY_BASE_URL${SH_PATH}" | bash`);
  });

  it('safely encodes an origin carrying a single quote (unreachable via URL grammar, but the guarantee is the encoder\'s)', () => {
    expect(buildShellSetupCommand("https://ev'il", SH_PATH))
      .toBe(`export FLOWAY_BASE_URL='https://ev'\\''il'; curl -fsSL "$FLOWAY_BASE_URL${SH_PATH}" | bash`);
  });
});

describe('buildPowerShellSetupCommand', () => {
  it('assigns the origin, then fetches through the same in-process variable', () => {
    expect(buildPowerShellSetupCommand('https://gateway.example', PS1_PATH))
      .toBe(`$FlowayBaseUrl = 'https://gateway.example'; irm "$FlowayBaseUrl${PS1_PATH}" | iex`);
  });

  it('does not touch Execution Policy', () => {
    const command = buildPowerShellSetupCommand('https://gateway.example', PS1_PATH);
    expect(command).not.toContain('ExecutionPolicy');
    expect(command).not.toContain('Bypass');
  });

  it('safely doubles a single quote in the origin', () => {
    expect(buildPowerShellSetupCommand("https://ev'il", PS1_PATH))
      .toBe(`$FlowayBaseUrl = 'https://ev''il'; irm "$FlowayBaseUrl${PS1_PATH}" | iex`);
  });
});
