export class OpenAIResponsesInvalidInputError extends Error {
  constructor(message: string, readonly param: string) {
    super(message);
    this.name = 'OpenAIResponsesInvalidInputError';
  }
}
