// Accepts already-started work that may outlive its originating operation.
// Gateway HTTP requests resolve the host implementation from their context;
// transports with a longer lifetime can supply their own implementation.
export type BackgroundScheduler = (promise: Promise<unknown>) => void;
