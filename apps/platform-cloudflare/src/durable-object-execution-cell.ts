import type { ExecutionCellNamespace } from '@floway-dev/platform';

export interface ExecutionDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export class DurableObjectExecutionCellNamespace implements ExecutionCellNamespace {
  constructor(private readonly namespace: ExecutionDurableObjectNamespace) {}

  fetch(cellId: string, request: Request): Promise<Response> {
    return this.namespace.get(this.namespace.idFromName(cellId)).fetch(request);
  }
}
