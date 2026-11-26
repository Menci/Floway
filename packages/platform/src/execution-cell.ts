// Addressable request/response execution cell. The platform decides how a
// cell id maps to an isolated owner (Durable Object, process-local actor, or
// worker); operation protocols remain in their owning package.
export interface ExecutionCellNamespace {
  fetch(cellId: string, request: Request): Promise<Response>;
}
