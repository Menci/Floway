import { rerankPipelines } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';

export const rerank = (dialect: RerankSourceProtocol) => serveHttp(rerankPipelines[dialect]);
