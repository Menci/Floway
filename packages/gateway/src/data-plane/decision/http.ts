import { decisionPipelines } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';
import type { DecisionProtocol } from '@floway-dev/protocols/common';

export const decision = (dialect: DecisionProtocol) => serveHttp(decisionPipelines[dialect]);
