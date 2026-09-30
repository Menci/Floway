import type { GatewayServices } from '../../../../pipeline/services.ts';
import type { WebSearchCallIR } from '../../../../tools/web-search/operations.ts';

export type SearchCall = () => Promise<WebSearchCallIR>;

export interface SearchServices extends GatewayServices { readonly searchCall: SearchCall }
