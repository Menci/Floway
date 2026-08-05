import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

import { SETUP_BASH_COMMON_CLI } from '../../../src/script-assets.generated.ts';

const functionStart = SETUP_BASH_COMMON_CLI.indexOf('_discover_cli() {');
const functionEnd = SETUP_BASH_COMMON_CLI.indexOf('\n\n_install_brew_cask() {', functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error('could not locate _discover_cli in the generated Bash installer');
const DISCOVER_CLI = SETUP_BASH_COMMON_CLI.slice(functionStart, functionEnd);

test('Bash CLI discovery rejects an inherited exported function', () => {
  const result = spawnSync('/bin/bash', ['-c', `
${DISCOVER_CLI}
kind=$(type -t claude 2>/dev/null || true)
_discover_cli claude
printf '%s|%s|%s\n' "$kind" "$DISCOVERED_BIN" "$DISCOVERED_COUNT"
`], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      'BASH_FUNC_claude%%': '() { printf "poisoned\\n"; }',
    },
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('function||0');
});
