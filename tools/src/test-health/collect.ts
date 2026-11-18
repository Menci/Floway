import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { unzipSync } from 'fflate';

import { downloadAttemptLogs, GhError, listAnnotations, listJobs, listRuns, type WorkflowRun } from './github.ts';
import { parseAnnotationTitle, parseJobLog, type JobTestResults } from './log.ts';

/** What one job of one run attempt observed about the tests it ran. */
export interface JobObservation extends JobTestResults {
  runId: number;
  attempt: number;
  headSha: string;
  branch: string;
  event: string;
  createdAt: string;
  job: string;
  /** `logs` when the full reporter output was read, `annotations` when only failures survive. */
  source: 'logs' | 'annotations';
}

const isTestJob = (name: string): boolean => /^(test|installers|test-installers)\b/.test(name);

const fromLogs = async (run: WorkflowRun, attempt: number): Promise<JobObservation[]> => {
  const archive = unzipSync(new Uint8Array(await downloadAttemptLogs(run.id, attempt)));
  const observations: JobObservation[] = [];
  for (const [entry, bytes] of Object.entries(archive)) {
    // Each job's full log sits at the archive root as `<n>_<job name>.txt`.
    const match = /^\d+_(.+)\.txt$/.exec(entry);
    if (!match || !isTestJob(match[1]!)) continue;
    observations.push({
      ...parseJobLog(new TextDecoder().decode(bytes)),
      runId: run.id, attempt, headSha: run.head_sha, branch: run.head_branch, event: run.event,
      createdAt: run.created_at, job: match[1]!.replace(/_/g, '/'), source: 'logs',
    });
  }
  return observations;
};

const fromAnnotations = async (run: WorkflowRun, attempt: number): Promise<JobObservation[]> => {
  const observations: JobObservation[] = [];
  for (const job of await listJobs(run.id, attempt)) {
    if (!isTestJob(job.name) || job.conclusion !== 'failure') continue;
    const failedTests = (await listAnnotations(job.id))
      .filter(annotation => annotation.annotation_level === 'failure')
      .map(annotation => parseAnnotationTitle(annotation.title))
      .filter(key => key !== undefined);
    observations.push({
      finishedFiles: [], failedTests, failedFiles: [], testedCommit: undefined,
      runId: run.id, attempt, headSha: run.head_sha, branch: run.head_branch, event: run.event,
      createdAt: run.created_at, job: job.name, source: 'annotations',
    });
  }
  return observations;
};

const observeAttempt = async (run: WorkflowRun, attempt: number): Promise<JobObservation[]> => {
  try {
    return await fromLogs(run, attempt);
  } catch (error) {
    if (!(error instanceof GhError && error.logsExpired)) throw error;
    return await fromAnnotations(run, attempt);
  }
};

/**
 * Collects every attempt of every finished Verify run into a per-attempt
 * cache, so an interrupted collection resumes where it stopped and a rerun
 * only fetches what is new.
 */
export const collect = async (cacheDir: string, since: string, onProgress: (done: number, total: number) => void): Promise<JobObservation[]> => {
  await mkdir(cacheDir, { recursive: true });
  const runs = (await listRuns('verify.yaml', since)).filter(run => run.conclusion !== null && run.conclusion !== 'cancelled');
  const attempts = runs.flatMap(run => Array.from({ length: run.run_attempt }, (_, index) => ({ run, attempt: index + 1 })));
  const observations: JobObservation[] = [];
  let done = 0;
  const queue = [...attempts];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { run, attempt } = next;
      const path = join(cacheDir, `${createHash('sha1').update(`${run.id}/${attempt}`).digest('hex')}.json`);
      let result: JobObservation[];
      try {
        result = JSON.parse(await readFile(path, 'utf8')) as JobObservation[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        result = await observeAttempt(run, attempt);
        await writeFile(path, JSON.stringify(result));
      }
      observations.push(...result);
      onProgress(++done, attempts.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return observations;
};
