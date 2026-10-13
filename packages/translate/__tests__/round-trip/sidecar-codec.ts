import { createAssistantTurnSidecarCodec } from '../../src/round-trip/codec.ts';

export const createTestSidecarCodec = (serverSecret = 'test-server-secret') => createAssistantTurnSidecarCodec(serverSecret);
