export class TranslateEventException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranslateEventException';
  }
}
