import type { BillableEntity } from '../../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../../pipeline/services.ts';
import type { PerformanceTelemetryContext } from '../../../../shared/telemetry/performance.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../types.ts';

/** How the ending reports what it did, once it knows. The identity and the counts arrive with
 *  the backend's own response, long after this run handed up. */
export type SettleImageCall = (billable: readonly BillableEntity[], failed: boolean, telemetry: PerformanceTelemetryContext | undefined) => void;

export type ImageCall = (settle: SettleImageCall) => AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;

export interface ImageServices extends GatewayServices { readonly imageCall: ImageCall }
