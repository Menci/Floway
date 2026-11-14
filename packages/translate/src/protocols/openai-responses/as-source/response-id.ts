export const createRandomOpenAIResponsesResponseId = (): string => `resp_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
