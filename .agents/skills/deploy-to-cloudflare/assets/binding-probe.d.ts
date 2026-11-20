export class ExecutionDO {
  constructor(context: DurableObjectState, env: unknown);
  fetch(): Response;
}
export class LogStreamDO {
  constructor(context: DurableObjectState, env: unknown);
  fetch(): Response;
}
declare const probe: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
export default probe;
