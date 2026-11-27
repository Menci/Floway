import { compose } from '../http.ts';
import { decisionDial } from './dial.ts';
import { httpTerminal } from '@floway-dev/upstream';

export const decision = compose('custom.decision', {
  entry: ['http', 'upstream', 'model', 'decision'],
  exit: ['http', 'decision'],
  stages: [decisionDial],
  ending: httpTerminal,
});
