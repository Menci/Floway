import { dial } from './dial.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import { wrapScalarInput } from './wrap-scalar-input.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const openaiEmbeddings: UpstreamPipeline<'openaiEmbeddings', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.openaiEmbeddings', {
  entry: ['http', 'upstream', 'model', 'openaiEmbeddings'],
  exit: ['http', 'openaiEmbeddings', 'usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    wrapScalarInput,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
