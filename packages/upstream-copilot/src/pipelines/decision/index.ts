import { dial } from './dial.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const decision: UpstreamPipeline<'decision', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.decision', {
  entry: ['http', 'upstream', 'model', 'decision'],
  exit: ['http', 'decision', 'usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
