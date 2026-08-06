import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_PATH = resolve(ROOT, 'AGENTS.md');
const EXPECTED_TITLE = '# Repository Agent Protocol';
const EXPECTED_SECTIONS = ['## Requirements', '## Index'] as const;
const PACKAGE_ROOTS = ['packages', 'apps'] as const;
const EXPECTED_TABLE_HEADERS = [
  '| Scope | Requirement | Enforcement |',
  '| Category | Entry | Overview |',
] as const;
const OVERVIEW_MAX_LENGTH = 64;
const OVERVIEW_MAX_WORDS = 6;

type IndexCategory = 'CI' | 'Skill' | 'Package';

interface IndexEntry {
  category: IndexCategory;
  entry: string;
}

interface IndexRow extends IndexEntry {
  overview: string;
}

const INDEX_CATEGORY_ORDER: Record<IndexCategory, number> = {
  CI: 0,
  Skill: 1,
  Package: 2,
};

const fail = (message: string): never => {
  throw new Error(`AGENTS.md protocol violation: ${message}`);
};

const isIndexCategory = (value: string | undefined): value is IndexCategory =>
  value === 'CI' || value === 'Skill' || value === 'Package';

const isHighLevelOverview = (value: string | undefined): value is string => {
  if (!value || value.length > OVERVIEW_MAX_LENGTH) return false;
  const wordCount = value.split(/\s+/).length;
  return (
    wordCount <= OVERVIEW_MAX_WORDS &&
    /^[A-Z][A-Za-z0-9 .-]*\.$/.test(value)
  );
};

const listFileNames = async (directory: string): Promise<string[]> =>
  (await readdir(resolve(ROOT, directory), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name);

const listDirectoryNames = async (directory: string): Promise<string[]> =>
  (await readdir(resolve(ROOT, directory), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

const discoverIndex = async (): Promise<IndexEntry[]> => {
  const workspaceConfig = await readFile(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const workspacePackageBlock = /^packages:\n((?:  - .+\n)+)/m.exec(workspaceConfig)?.[1];
  const workspacePackagePatterns = workspacePackageBlock
    ?.trimEnd()
    .split('\n')
    .map(line => line.slice('  - '.length));
  const expectedPackagePatterns = PACKAGE_ROOTS.map(root => `${root}/*`);
  if (JSON.stringify(workspacePackagePatterns) !== JSON.stringify(expectedPackagePatterns)) {
    fail(
      `package discovery must match pnpm-workspace.yaml; expected ${JSON.stringify(expectedPackagePatterns)}`,
    );
  }

  const workflows = (await listFileNames('.github/workflows'))
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map(entry => ({ category: 'CI', entry: `.github/workflows/${entry}` }) satisfies IndexEntry);

  const skills = await Promise.all(
    (await listDirectoryNames('.agents/skills')).map(async name => ({
      name,
      files: await listFileNames(`.agents/skills/${name}`),
    })),
  );
  const skillEntries = skills
    .filter(({ files }) => files.includes('SKILL.md'))
    .map(({ name }) => ({ category: 'Skill', entry: `$${name}` }) satisfies IndexEntry);

  const packageDirectories = (
    await Promise.all(
      PACKAGE_ROOTS.map(async parent =>
        (await listDirectoryNames(parent)).map(name => `${parent}/${name}`)),
    )
  ).flat();
  const packages = await Promise.all(
    packageDirectories.map(async directory => ({
      directory,
      files: await listFileNames(directory),
    })),
  );
  const packageEntries = packages
    .filter(({ files }) => files.includes('package.json'))
    .map(({ directory }) => ({ category: 'Package', entry: directory }) satisfies IndexEntry);

  return [...workflows, ...skillEntries, ...packageEntries].sort(
    (left, right) =>
      INDEX_CATEGORY_ORDER[left.category] - INDEX_CATEGORY_ORDER[right.category] ||
      left.entry.localeCompare(right.entry),
  );
};

const lines = (await readFile(AGENTS_PATH, 'utf8')).trimEnd().split('\n');
if (lines[0] !== EXPECTED_TITLE) fail(`first line must be ${JSON.stringify(EXPECTED_TITLE)}`);

const sectionEntries = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => line.startsWith('## '));

if (sectionEntries.length !== EXPECTED_SECTIONS.length) {
  fail(`expected exactly ${EXPECTED_SECTIONS.length} level-two sections`);
}

for (const [index, expected] of EXPECTED_SECTIONS.entries()) {
  const actual = sectionEntries[index];
  if (actual?.line !== expected) fail(`section ${index + 1} must be ${JSON.stringify(expected)}`);
}

const titleBody = lines.slice(1, sectionEntries[0]?.index);
if (titleBody.some(line => line !== '')) fail('the title may be followed only by the Requirements table');

for (const [index, section] of sectionEntries.entries()) {
  const end = sectionEntries[index + 1]?.index ?? lines.length;
  const body = lines.slice(section.index + 1, end);
  const content = body.filter(line => line !== '');
  if (content.length < 3) fail(`${section.line} must contain a Markdown table`);
  if (content[0] !== EXPECTED_TABLE_HEADERS[index]) {
    fail(`${section.line} must start with ${JSON.stringify(EXPECTED_TABLE_HEADERS[index])}`);
  }
  if (content.some(line => !line.startsWith('|') || !line.endsWith('|'))) {
    fail(`${section.line} may contain only one Markdown table`);
  }
  if (!/^\|(?:-+\|)+$/.test(content[1]?.replaceAll(' ', '') ?? '')) {
    fail(`${section.line} must use a Markdown table separator as its second row`);
  }
  const expectedColumns = 3;
  if (content.some(line => line.split('|').length !== expectedColumns + 2)) {
    fail(`${section.line} must keep its ${expectedColumns} prescribed columns`);
  }
}

const indexSection = sectionEntries[1];
const indexEnd = lines.length;
const indexRows = lines
  .slice((indexSection?.index ?? 0) + 1, indexEnd)
  .filter(line => line !== '')
  .slice(2)
  .map((line): IndexRow => {
    const cells = line
      .slice(1, -1)
      .split('|')
      .map(cell => cell.trim());
    const category = cells[0];
    const encodedEntry = cells[1];
    const overview = cells[2];
    if (!isIndexCategory(category)) {
      return fail(
        `Index category must be CI, Skill, or Package; received ${JSON.stringify(category)}`,
      );
    }
    if (!encodedEntry?.startsWith('`') || !encodedEntry.endsWith('`')) {
      fail(`Index entries must be single code spans; received ${JSON.stringify(encodedEntry)}`);
    }
    if (!isHighLevelOverview(overview)) {
      fail(
        `Index overviews must be plain sentences of at most ${OVERVIEW_MAX_WORDS} words and ${OVERVIEW_MAX_LENGTH} characters; received ${JSON.stringify(overview)}`,
      );
    }
    return { category, entry: encodedEntry.slice(1, -1), overview };
  });

const expectedIndexRows = await discoverIndex();
const indexedEntries = indexRows.map(({ category, entry }) => ({ category, entry }));
if (JSON.stringify(indexedEntries) !== JSON.stringify(expectedIndexRows)) {
  fail(
    `Index must exactly inventory CI workflows, skills, and package directories in sorted order; expected ${JSON.stringify(expectedIndexRows)}`,
  );
}
