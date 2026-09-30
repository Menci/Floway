import { runWebSearchCall } from './execute.ts';
import type { Fields } from './facts.ts';
import { writeSettlement } from '../../../../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const webSearchSubRequestPipeline: Pipeline<Fields<'request.webSearch.action'>, Fields<'response.webSearch.ir'>> =
  compose('webSearchSubRequest', [
    writeSettlement(() => false),
    runWebSearchCall,
  ]);
