import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { unzipSync } from 'fflate';

import { downloadAttemptLogs, GhError, listAnnotations, listJobs, listRuns, type WorkflowRun } from './github.ts';
import { parseAnnotationTitle, parseJobLog, type Failure, type JobTestResults } from './log.ts';

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

interface AnnotatedJob {
  job: string;
  failures: Failure[];
}

const isTestJob = (name: string): boolean => /^(test|installers|test-installers)\b/.test(name);

const fromLogs = (run: WorkflowRun, attempt: number, archive: Uint8Array): JobObservation[] =>
  Object.entries(unzipSync(archive)).flatMap(([entry, bytes]) => {
    // Each job's full log sits at the archive root as `<n>_<job name>.txt`.
    const match = /^\d+_(.+)\.txt$/.exec(entry);
    if (!match || !isTestJob(match[1]!)) return [];
    return [{
      ...parseJobLog(new TextDecoder().decode(bytes)),
      runId: run.id, attempt, headSha: run.head_sha, branch: run.head_branch, event: run.event,
      createdAt: run.created_at, job: match[1]!.replace(/_/g, '/'), source: 'logs' as const,
    }];
  });

const fetchAnnotations = async (run: WorkflowRun, attempt: number): Promise<AnnotatedJob[]> => {
  const jobs: AnnotatedJob[] = [];
  for (const job of await listJobs(run.id, attempt)) {
    if (!isTestJob(job.name) || job.conclusion !== 'failure') continue;
    const failures = (await listAnnotations(job.id))
      .filter(annotation => annotation.annotation_level === 'failure')
      .flatMap(annotation => {
        const key = parseAnnotationTitle(annotation.title);
        return key === undefined ? [] : [{ key, error: annotation.message.split('\n')[0]!.trim() }];
      });
    jobs.push({ job: job.name, failures });
  }
  return jobs;
};

const fromAnnotations = (run: WorkflowRun, attempt: number, jobs: AnnotatedJob[]): JobObservation[] =>
  jobs.map(({ job, failures }) => ({
    cleanFiles: [], failures, testedCommit: undefined,
    runId: run.id, attempt, headSha: run.head_sha, branch: run.head_branch, event: run.event,
    createdAt: run.created_at, job, source: 'annotations',
  }));

const readCached = async (path: string): Promise<Buffer | undefined> => {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

// The raw log archive is cached rather than its parse, so a parser change
// re-reads history without downloading it again. Runs past log retention
// cache their failure annotations instead.
const observeAttempt = async (cacheDir: string, run: WorkflowRun, attempt: number): Promise<JobObservation[]> => {
  const archivePath = join(cacheDir, `${run.id}-${attempt}.zip`);
  const annotationsPath = join(cacheDir, `${run.id}-${attempt}.annotations.json`);
  const archive = await readCached(archivePath);
  if (archive !== undefined) return fromLogs(run, attempt, archive);
  const annotations = await readCached(annotationsPath);
  if (annotations !== undefined) return fromAnnotations(run, attempt, JSON.parse(annotations.toString('utf8')) as AnnotatedJob[]);
  try {
    const downloaded = await downloadAttemptLogs(run.id, attempt);
    await writeFile(archivePath, downloaded);
    return fromLogs(run, attempt, downloaded);
  } catch (error) {
    if (!(error instanceof GhError && error.logsExpired)) throw error;
    const jobs = await fetchAnnotations(run, attempt);
    await writeFile(annotationsPath, JSON.stringify(jobs));
    return fromAnnotations(run, attempt, jobs);
  }
};

/**
 * Collects every attempt of every finished Verify run through a per-attempt
 * cache, so an interrupted collection resumes where it stopped and a rerun
 * only fetches what is new.
 */
export const collect = async (cacheDir: string, since: string, onProgress: (done: number, total: number) => void): Promise<JobObservation[]> => {
  await mkdir(cacheDir, { recursive: true });
  const runs = (await listRuns('verify.yaml', since)).filter(run => run.conclusion !== null && run.conclusion !== 'cancelled');
  const queue = runs.flatMap(run => Array.from({ length: run.run_attempt }, (_, index) => ({ run, attempt: index + 1 })));
  const total = queue.length;
  const observations: JobObservation[] = [];
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      observations.push(...await observeAttempt(cacheDir, next.run, next.attempt));
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return observations;
};
