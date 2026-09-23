export const MODEL_ERROR_TOOLTIP_LENGTH = 240;
export const MODEL_ERROR_EDITOR_LENGTH = 1600;

export const modelErrorExcerpt = (message: string, maxLength: number): string => message.length > maxLength
  ? `${message.slice(0, maxLength - 1)}…`
  : message;
