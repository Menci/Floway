// Reads Vitest's default CI reporter output out of an Actions job log. The
// reporter prints one line per finished file with its test, failure, and skip
// counts and, in its closing summary, one `FAIL` line per failed test carrying
// the full `describe > test` name, which is the same name `vitest list --json`
// reports, followed by the error. A passing test is never printed by name, so
// the only pass evidence a log holds is a file that finished with nothing
// failed or skipped.

export interface Failure {
  /** `project|file|name` for a failed test, `project|file` for a file that failed outside any test. */
  key: string;
  /** The first line of the reported error. */
  error: string;
}

export interface JobTestResults {
  /** `project|file` of every file that finished with every test passing and none skipped. */
  cleanFiles: string[];
  failures: Failure[];
  /** The commit the job checked out, which for pull requests is the test merge commit. */
  testedCommit: string | undefined;
}

export const fileKey = (project: string, file: string): string => `${project}|${file}`;
export const testKey = (project: string, file: string, name: string): string => `${project}|${file}|${name}`;

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const FILE_LINE = /^ [✓❯↓] +(\S+) +(\S+_test\.tsx?) \(\d+ tests?( \|[^)]*)?\)/;
const FAIL_LINE = /^ FAIL +(\S+) +(\S+_test\.tsx?)(?: > (.+?))?(?: \[ \S+ \])?$/;

export const parseJobLog = (log: string): JobTestResults => {
  const cleanFiles = new Set<string>();
  const failures = new Map<string, string>();
  let testedCommit: string | undefined;
  let commitFollows = false;
  // Tests that failed with the same error share one block: consecutive `FAIL`
  // lines followed by that error.
  let awaitingError: string[] = [];
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
      if (file[3] === undefined) cleanFiles.add(fileKey(file[1]!, file[2]!));
      continue;
    }
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      const [, project, path, name] = fail;
      const key = name === undefined ? fileKey(project!, path!) : testKey(project!, path!, name);
      failures.set(key, '');
      awaitingError.push(key);
      continue;
    }
    if (awaitingError.length > 0 && line !== '') {
      for (const key of awaitingError) failures.set(key, line.trim());
      awaitingError = [];
    }
  }
  return { cleanFiles: [...cleanFiles], failures: [...failures].map(([key, error]) => ({ key, error })), testedCommit };
};

// Logs past the retention window are gone, but the check-run annotations the
// Vitest GitHub reporter attached to a failed job stay, titled
// `[project] file > name` with the error as their message. They record
// failures only.
export const parseAnnotationTitle = (title: string): string | undefined => {
  const match = /^\[(\S+)\] (\S+_test\.tsx?) > (.+)$/.exec(title);
  return match ? testKey(match[1]!, match[2]!, match[3]!) : undefined;
};
