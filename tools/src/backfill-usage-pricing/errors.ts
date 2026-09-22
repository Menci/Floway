export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

export const inputError = (code: string, message: string): ToolError =>
  new ToolError(code, message, 2);

export const safetyError = (code: string, message: string): ToolError =>
  new ToolError(code, message, 3);

export const verificationError = (code: string, message: string): ToolError =>
  new ToolError(code, message, 4);
