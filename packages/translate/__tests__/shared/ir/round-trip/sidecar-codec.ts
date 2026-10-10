import type { AssistantTurnSidecarCodec } from '../../../../src/types.ts';

export const createTestSidecarCodec = (): AssistantTurnSidecarCodec => {
  const sidecars = new Map<unknown, { source: string; value: unknown }>();
  return {
    encapsulate: async (source, value) => {
      const data = crypto.randomUUID();
      sidecars.set(data, { source, value: { ...value as object, source } });
      return data;
    },
    unencapsulate: async (source, data) => {
      const sidecar = sidecars.get(data);
      return sidecar?.source === source ? sidecar.value : undefined;
    },
  };
};
