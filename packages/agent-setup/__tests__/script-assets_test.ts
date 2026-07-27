import { test } from 'vitest';

import {
  SETUP_BASH_COMMON,
  SETUP_BASH_COMMON_CLI,
  SETUP_BASH_COMMON_JQ,
  SETUP_BASH_COMMON_MAIN,
  SETUP_BASH_COMMON_MANAGED_FILE,
  SETUP_BASH_COMMON_OUTPUT,
  SETUP_BASH_COMMON_PROCESS,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_COMMON_CLI,
  SETUP_POWERSHELL_COMMON_JSON_DOCUMENT,
  SETUP_POWERSHELL_COMMON_MAIN,
  SETUP_POWERSHELL_COMMON_MANAGED_FILE,
  SETUP_POWERSHELL_COMMON_OUTPUT,
  SETUP_POWERSHELL_COMMON_PLATFORM,
  SETUP_POWERSHELL_COMMON_PROCESS,
  SETUP_SCRIPT_SOURCE_FRAGMENTS,
} from '../src/script-assets.generated.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

interface Section {
  file: string;
  source: string;
  start?: string;
  end?: string;
  append?: string;
}

// The prejoined common bodies are what the routes actually serve, and the
// generator's manifest is the only other place their section order and cut
// points are written down. These tables restate that tiling independently, so
// reordering, dropping, or re-cutting a section in the manifest and
// regenerating cannot ship a different installer on a green suite.
const BASH_COMMON_SECTIONS: readonly Section[] = [
  { file: 'installers/bash/common/output.sh', source: SETUP_BASH_COMMON_OUTPUT, append: '\n' },
  { file: 'installers/bash/common/main.sh', source: SETUP_BASH_COMMON_MAIN, end: '# --- run' },
  { file: 'installers/bash/common/process.sh', source: SETUP_BASH_COMMON_PROCESS, append: '\n' },
  { file: 'installers/bash/common/jq.sh', source: SETUP_BASH_COMMON_JQ, append: '\n' },
  { file: 'installers/bash/common/cli.sh', source: SETUP_BASH_COMMON_CLI, end: '_install_brew_cask() {' },
  { file: 'installers/bash/common/managed-file.sh', source: SETUP_BASH_COMMON_MANAGED_FILE, append: '\n' },
  { file: 'installers/bash/common/cli.sh', source: SETUP_BASH_COMMON_CLI, start: '_install_brew_cask() {' },
  { file: 'installers/bash/common/main.sh', source: SETUP_BASH_COMMON_MAIN, start: '# --- run' },
];

const POWERSHELL_COMMON_SECTIONS: readonly Section[] = [
  { file: 'installers/powershell/common/output.ps1', source: SETUP_POWERSHELL_COMMON_OUTPUT },
  { file: 'installers/powershell/common/platform.ps1', source: SETUP_POWERSHELL_COMMON_PLATFORM, end: 'function Get-SetupPlatform' },
  { file: 'installers/powershell/common/json-document.ps1', source: SETUP_POWERSHELL_COMMON_JSON_DOCUMENT, append: '\n' },
  { file: 'installers/powershell/common/main.ps1', source: SETUP_POWERSHELL_COMMON_MAIN, end: '# --- run' },
  { file: 'installers/powershell/common/managed-file.ps1', source: SETUP_POWERSHELL_COMMON_MANAGED_FILE, end: '# Rollback retains' },
  { file: 'installers/powershell/common/process.ps1', source: SETUP_POWERSHELL_COMMON_PROCESS, end: '# Run a fixed package-manager' },
  { file: 'installers/powershell/common/platform.ps1', source: SETUP_POWERSHELL_COMMON_PLATFORM, start: 'function Get-SetupPlatform', append: '\n' },
  {
    file: 'installers/powershell/common/process.ps1',
    source: SETUP_POWERSHELL_COMMON_PROCESS,
    start: '# Run a fixed package-manager',
    end: '# Run a child process with captured output',
  },
  { file: 'installers/powershell/common/cli.ps1', source: SETUP_POWERSHELL_COMMON_CLI, append: '\n' },
  { file: 'installers/powershell/common/managed-file.ps1', source: SETUP_POWERSHELL_COMMON_MANAGED_FILE, start: '# Rollback retains', append: '\n' },
  { file: 'installers/powershell/common/process.ps1', source: SETUP_POWERSHELL_COMMON_PROCESS, start: '# Run a child process with captured output' },
  { file: 'installers/powershell/common/main.ps1', source: SETUP_POWERSHELL_COMMON_MAIN, start: '# --- run' },
];

const PLATFORM_COMMONS = [
  { platform: 'bash', prejoined: SETUP_BASH_COMMON, sections: BASH_COMMON_SECTIONS },
  { platform: 'powershell', prejoined: SETUP_POWERSHELL_COMMON, sections: POWERSHELL_COMMON_SECTIONS },
];

const startOffset = ({ file, source, start }: Section): number => {
  if (start === undefined) return 0;
  const index = source.indexOf(start);
  assert(index !== -1, `${file} does not contain the start boundary ${JSON.stringify(start)}`);
  return index;
};

const sliceOf = (section: Section): string => {
  const start = startOffset(section);
  if (section.end === undefined) return section.source.slice(start);
  const end = section.source.indexOf(section.end, start);
  assert(end !== -1, `${section.file} does not contain the end boundary ${JSON.stringify(section.end)}`);
  return section.source.slice(start, end);
};

test('generated installer sources match the checked-in canonical fragments byte for byte', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [file, generated] of SETUP_SCRIPT_SOURCE_FRAGMENTS) {
    assertEquals(generated, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
});

test.each(PLATFORM_COMMONS)('the prejoined $platform common body is exactly its declared section tiling', ({ prejoined, sections }) => {
  assertEquals(sections.map(section => sliceOf(section) + (section.append ?? '')).join(''), prejoined);
});

test.each(PLATFORM_COMMONS)('every byte of each $platform source file reaches the prejoined body', ({ sections }) => {
  const sourceByFile = new Map(sections.map(({ file, source }) => [file, source]));
  for (const [file, source] of sourceByFile) {
    const tiles = sections.filter(section => section.file === file).sort((a, b) => startOffset(a) - startOffset(b));
    assertEquals(tiles.map(sliceOf).join(''), source, `${file} is not fully covered by its sections`);
  }
});
