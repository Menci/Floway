import { chatBodyEntry, chatBodyExit, passthrough, type ChatOperation } from './pipeline.ts';
import { defineOperationStage } from '../../pipeline/facts.ts';

export const enterChatProtocol = (operation: ChatOperation) => defineOperationStage({
  name: `${operation}.enter-body`,
  request: { needs: chatBodyEntry(operation) },
  into: { body: passthrough(chatBodyEntry(operation), chatBodyExit(operation)) },
  async execute(facts, scope) {
    return await scope.into.body(facts);
  },
});
