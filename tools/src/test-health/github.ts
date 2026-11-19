import { spawn } from 'node:child_process';

export const REPOSITORY = 'Menci/Floway';

const gh = (args: readonly string[]): Promise<Buffer> => new Promise((resolve, reject) => {
  const child = spawn('gh', ['api', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', code => {
    if (code === 0) resolve(Buffer.concat(stdout));
    else reject(new GhError(args.join(' '), Buffer.concat(stderr).toString('utf8').trim()));
  });
});

export class GhError extends Error {
  constructor(readonly request: string, readonly detail: string) {
    super(`gh api ${request}: ${detail}`);
    this.name = 'GhError';
  }

  // Actions deletes logs once the repository's retention window passes and
  // answers 404 or 410 for them from then on.
  get logsExpired(): boolean {
    return /HTTP 404|HTTP 410/.test(this.detail);
  }
}

// The GitHub API sheds load with 5xx responses, TLS handshake timeouts, and
// HTTP/2 stream resets. Only a 4xx is an answer about the request itself, so
// everything else is retried a bounded number of times.
const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const transient = error instanceof GhError && !/HTTP 4\d\d/.test(error.detail);
      if (!transient || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000));
    }
  }
};

export const getJson = async <T>(path: string): Promise<T> =>
  JSON.parse((await withRetry(() => gh([path]))).toString('utf8')) as T;

export const getBytes = (path: string): Promise<Buffer> => withRetry(() => gh([path]));

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  created_at: string;
  conclusion: string | null;
}

export interface Job {
  id: number;
  name: string;
  conclusion: string | null;
}

export interface Annotation {
  path: string;
  title: string;
  annotation_level: string;
  message: string;
}

// The runs listing caps pagination at 1,000 results per query, so the full
// history is walked as consecutive creation-date windows, each below the cap.
export const listRuns = async (workflow: string, since: string): Promise<WorkflowRun[]> => {
  const runs = new Map<number, WorkflowRun>();
  let before = new Date(Date.now() + 86_400_000).toISOString();
  for (;;) {
    let oldest: string | undefined;
    for (let page = 1; page <= 10; page++) {
      const { workflow_runs } = await getJson<{ workflow_runs: WorkflowRun[] }>(
        `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100&page=${page}&created=${encodeURIComponent(`${since}..${before}`)}`,
      );
      for (const run of workflow_runs) runs.set(run.id, run);
      if (workflow_runs.length > 0) oldest = workflow_runs.at(-1)!.created_at;
      if (workflow_runs.length < 100) return [...runs.values()];
    }
    if (oldest === undefined || oldest === before) throw new Error(`more than 1,000 runs were created at ${before}`);
    before = oldest;
  }
};

export const listJobs = async (runId: number, attempt: number): Promise<Job[]> =>
  (await getJson<{ jobs: Job[] }>(`repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)).jobs;

export const listAnnotations = (jobId: number): Promise<Annotation[]> =>
  getJson<Annotation[]>(`repos/${REPOSITORY}/check-runs/${jobId}/annotations?per_page=100`);

export const downloadAttemptLogs = (runId: number, attempt: number): Promise<Buffer> =>
  getBytes(`repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/logs`);
