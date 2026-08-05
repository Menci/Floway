// Embeds the canonical Agent Setup fragments as runtime-neutral string
// constants in `src/script-assets.generated.ts`. The ordered manifest here also
// prejoins each platform's common body, so runtime code and the installer
// harness execute the same artifact.
//
// Run `pnpm --filter @floway-dev/agent-setup run generate-assets` to rewrite
// the generated module; pass `--check` to fail when checked-in output drifts.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { typescriptString } from './typescript-string.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const GENERATED_PATH = resolve(PACKAGE_ROOT, 'src/script-assets.generated.ts');

interface SourceSection {
  name: string;
  file: string;
  start?: string;
  end?: string;
  append?: string;
}

interface PlatformSources {
  common: readonly SourceSection[];
  agents: readonly SourceSection[];
}

// Source files are grouped by responsibility, while these section boundaries
// preserve the public script's established byte order.
const scriptSources = {
  bash: {
    common: [
      { name: 'SETUP_BASH_COMMON_OUTPUT', file: 'installers/bash/common/output.sh', append: '\n' },
      { name: 'SETUP_BASH_COMMON_MAIN', file: 'installers/bash/common/main.sh', end: '# --- run' },
      { name: 'SETUP_BASH_COMMON_PROCESS', file: 'installers/bash/common/process.sh', append: '\n' },
      { name: 'SETUP_BASH_COMMON_JQ', file: 'installers/bash/common/jq.sh', append: '\n' },
      { name: 'SETUP_BASH_COMMON_CLI', file: 'installers/bash/common/cli.sh', end: '_install_brew_cask() {' },
      { name: 'SETUP_BASH_COMMON_MANAGED_FILE', file: 'installers/bash/common/managed-file.sh', append: '\n' },
      { name: 'SETUP_BASH_COMMON_CLI', file: 'installers/bash/common/cli.sh', start: '_install_brew_cask() {' },
      { name: 'SETUP_BASH_COMMON_MAIN', file: 'installers/bash/common/main.sh', start: '# --- run' },
    ],
    agents: [
      { name: 'SETUP_BASH_CLAUDE', file: 'installers/bash/claude.sh' },
      { name: 'SETUP_BASH_CODEX', file: 'installers/bash/codex.sh' },
    ],
  },
  powershell: {
    common: [
      { name: 'SETUP_POWERSHELL_COMMON_OUTPUT', file: 'installers/powershell/common/output.ps1' },
      { name: 'SETUP_POWERSHELL_COMMON_PLATFORM', file: 'installers/powershell/common/platform.ps1', end: 'function Get-SetupPlatform' },
      { name: 'SETUP_POWERSHELL_COMMON_JSON_DOCUMENT', file: 'installers/powershell/common/json-document.ps1', append: '\n' },
      { name: 'SETUP_POWERSHELL_COMMON_MAIN', file: 'installers/powershell/common/main.ps1', end: '# --- run' },
      { name: 'SETUP_POWERSHELL_COMMON_MANAGED_FILE', file: 'installers/powershell/common/managed-file.ps1', end: '# Rollback retains' },
      { name: 'SETUP_POWERSHELL_COMMON_PROCESS', file: 'installers/powershell/common/process.ps1', end: '# Run a fixed package-manager' },
      { name: 'SETUP_POWERSHELL_COMMON_PLATFORM', file: 'installers/powershell/common/platform.ps1', start: 'function Get-SetupPlatform', append: '\n' },
      {
        name: 'SETUP_POWERSHELL_COMMON_PROCESS',
        file: 'installers/powershell/common/process.ps1',
        start: '# Run a fixed package-manager',
        end: '# Run a child process with captured output',
      },
      { name: 'SETUP_POWERSHELL_COMMON_CLI', file: 'installers/powershell/common/cli.ps1', append: '\n' },
      { name: 'SETUP_POWERSHELL_COMMON_MANAGED_FILE', file: 'installers/powershell/common/managed-file.ps1', start: '# Rollback retains', append: '\n' },
      { name: 'SETUP_POWERSHELL_COMMON_PROCESS', file: 'installers/powershell/common/process.ps1', start: '# Run a child process with captured output' },
      { name: 'SETUP_POWERSHELL_COMMON_MAIN', file: 'installers/powershell/common/main.ps1', start: '# --- run' },
    ],
    agents: [
      { name: 'SETUP_POWERSHELL_CLAUDE', file: 'installers/powershell/claude.ps1' },
      { name: 'SETUP_POWERSHELL_CODEX', file: 'installers/powershell/codex.ps1' },
    ],
  },
} as const satisfies Record<string, PlatformSources>;

const allSections = Object.values(scriptSources).flatMap(({ common, agents }) => [...common, ...agents]);
const sourceFiles = new Map<string, string>();
for (const { name, file } of allSections) {
  const existing = sourceFiles.get(name);
  if (existing !== undefined && existing !== file) throw new Error(`${name} maps to both ${existing} and ${file}`);
  sourceFiles.set(name, file);
}

const sourceByName = new Map(await Promise.all([...sourceFiles].map(async ([name, file]) => [
  name,
  await readFile(resolve(PACKAGE_ROOT, file), 'utf8'),
] as const)));

const findBoundary = (source: string, boundary: string, from: number, name: string): number => {
  const index = source.indexOf(boundary, from);
  if (index === -1) throw new Error(`${name} does not contain boundary ${JSON.stringify(boundary)}`);
  return index;
};

const renderSection = (section: SourceSection): string => {
  const source = sourceByName.get(section.name);
  if (source === undefined) throw new Error(`source not loaded for ${section.name}`);
  const start = section.start === undefined ? 0 : findBoundary(source, section.start, 0, section.name);
  const end = section.end === undefined ? source.length : findBoundary(source, section.end, start, section.name);
  return source.slice(start, end) + (section.append ?? '');
};

const sourceConstants = [...sourceFiles].map(([name]) => {
  const source = sourceByName.get(name);
  if (source === undefined) throw new Error(`source not loaded for ${name}`);
  return `export const ${name} = ${typescriptString(source)};`;
}).join('\n\n');
const commonConstants = Object.entries(scriptSources).map(([platform, { common }]) =>
  `export const SETUP_${platform.toUpperCase()}_COMMON = ${typescriptString(common.map(renderSection).join(''))};`).join('\n\n');
const sourceFragments = [...sourceFiles].map(([name, file]) => `  [${typescriptString(file)}, ${name}],`).join('\n');
const fileList = [...sourceFiles.values()].map(file => `// - ${file}`).join('\n');
const expected = `// GENERATED by scripts/generate-assets.ts — do not edit by hand.
//
// Canonical installer source files embedded verbatim from:
${fileList}
// Regenerate after editing a fragment:
// \`pnpm --filter @floway-dev/agent-setup run generate-assets\`.

${sourceConstants}

${commonConstants}

export const SETUP_SCRIPT_SOURCE_FRAGMENTS = [
${sourceFragments}
] as const;
`;

if (process.argv.includes('--check')) {
  const actual = await readFile(GENERATED_PATH, 'utf8').catch((error: NodeJS.ErrnoException) => {
    // A missing generated file is drift the check should report; any other read
    // failure (permissions, I/O) is a real fault and must propagate.
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (actual !== expected) {
    console.error('script-assets.generated.ts is out of date with the canonical installer fragments.');
    console.error('Run: pnpm --filter @floway-dev/agent-setup run generate-assets');
    process.exit(1);
  }
  console.log('script-assets.generated.ts is up to date.');
} else {
  await writeFile(GENERATED_PATH, expected);
  console.log(`Wrote ${GENERATED_PATH}`);
}
