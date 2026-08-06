// Addressable request/response execution cell. The platform decides how a
// cell id maps to an isolated owner (Durable Object, process-local actor, or
// worker); operation protocols remain in their owning package.
export interface ExecutionCellNamespace {
  fetch(cellId: string, request: Request): Promise<Response>;
}

export class InProcessExecutionCellNamespace implements ExecutionCellNamespace {
  private readonly executions = new Map<string, Promise<ExecutionResponseSnapshot>>();

  constructor(private readonly handler: (request: Request) => Promise<Response>) {}

  async fetch(cellId: string, request: Request): Promise<Response> {
    let execution = this.executions.get(cellId);
    if (execution === undefined) {
      execution = this.handler(request).then(snapshotExecutionResponse);
      this.executions.set(cellId, execution);
      void execution.then(
        () => this.executions.delete(cellId),
        () => this.executions.delete(cellId),
      );
    }
    return responseFromExecutionSnapshot(await execution);
  }
}

export interface ExecutionResponseSnapshot {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export const snapshotExecutionResponse = async (response: Response): Promise<ExecutionResponseSnapshot> => ({
  status: response.status,
  statusText: response.statusText,
  headers: [...response.headers],
  body: response.body === null ? null : await response.arrayBuffer(),
});

export const responseFromExecutionSnapshot = (snapshot: ExecutionResponseSnapshot): Response => new Response(snapshot.body?.slice(0) ?? null, {
  status: snapshot.status,
  statusText: snapshot.statusText,
  headers: snapshot.headers,
});
