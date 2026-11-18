// Reads Vitest's default CI reporter output out of an Actions job log. The
// reporter prints one line per finished file and, in its closing summary, one
// `FAIL` line per failed test carrying the full `describe > test` name, which
// is the same name `vitest list --json` reports. A passing test is not printed
// on its own, so a test passes in a job when its file finished there and no
// `FAIL` line names it.

export interface JobTestResults {
  /** `project|file` of every file that finished, with or without failures. */
  finishedFiles: string[];
  /** `project|file|name` of every failed test. */
  failedTests: string[];
  /** `project|file` of every file that failed outside any test (import or suite errors). */
  failedFiles: string[];
  /** The commit the job checked out, which for pull requests is the test merge commit. */
  testedCommit: string | undefined;
}

export const fileKey = (project: string, file: string): string => `${project}|${file}`;
export const testKey = (project: string, file: string, name: string): string => `${project}|${file}|${name}`;

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const FILE_LINE = /^ [✓❯↓] +(\S+) +(\S+_test\.tsx?) \(\d+ tests?/;
const FAIL_LINE = /^ FAIL +(\S+) +(\S+_test\.tsx?)(?: > (.+?))?(?: \[ \S+ \])?$/;

export const parseJobLog = (log: string): JobTestResults => {
  const finishedFiles = new Set<string>();
  const failedTests = new Set<string>();
  const failedFiles = new Set<string>();
  let testedCommit: string | undefined;
  let commitFollows = false;
  for (const raw of log.split('\n')) {
    const line = raw.replace(TIMESTAMP, '').replace(ANSI, '').trimEnd();
    if (commitFollows) {
      commitFollows = false;
      if (/^[0-9a-f]{40}$/.test(line)) testedCommit ??= line;
      continue;
    }
    if (line.endsWith('/usr/bin/git log -1 --format=%H')) {
      commitFollows = true;
      continue;
    }
    const file = FILE_LINE.exec(line);
    if (file) {
      finishedFiles.add(fileKey(file[1]!, file[2]!));
      continue;
    }
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      const [, project, path, name] = fail;
      if (name === undefined) failedFiles.add(fileKey(project!, path!));
      else failedTests.add(testKey(project!, path!, name));
    }
  }
  return { finishedFiles: [...finishedFiles], failedTests: [...failedTests], failedFiles: [...failedFiles], testedCommit };
};

// Logs past the retention window are gone, but the check-run annotations the
// Vitest GitHub reporter attached to a failed job stay, titled
// `[project] file > name`. They record failures only.
export const parseAnnotationTitle = (title: string): string | undefined => {
  const match = /^\[(\S+)\] (\S+_test\.tsx?) > (.+)$/.exec(title);
  return match ? testKey(match[1]!, match[2]!, match[3]!) : undefined;
};
