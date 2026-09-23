// Addressable request/response execution cell. The platform decides how a
// cell id maps to an isolated owner (Durable Object, process-local actor, or
// worker); operation protocols remain in their owning package.
export interface ExecutionCellNamespace {
  fetch(cellId: string, request: Request): Promise<Response>;
}

export class InProcessExecutionCellNamespace implements ExecutionCellNamespace {
  private readonly executions = new Map<string, Promise<Response>>();

  constructor(private readonly handler: (request: Request) => Promise<Response>) {}

  async fetch(cellId: string, request: Request): Promise<Response> {
    let execution = this.executions.get(cellId);
    if (execution === undefined) {
      execution = this.handler(request);
      this.executions.set(cellId, execution);
      const clear = (): void => { this.executions.delete(cellId); };
      void execution.then(clear, clear);
    }
    return (await execution).clone();
  }
}
