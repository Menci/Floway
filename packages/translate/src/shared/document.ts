import { TranslateInputException } from './input-error.ts';
import type { IRInputDocument, IRInputDocumentContentPart, IRInputMedia } from '../ir/input/types.ts';

export const DOCUMENT_CLOSE_TAG = '</document>';

export const documentOpening = (document: IRInputDocument): string => {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return [
    '<document>',
    ...(document.title == null ? [] : [`<title>${escape(document.title)}</title>`]),
    ...(document.context == null ? [] : [`<context>${escape(document.context)}</context>`]),
  ].join('\n');
};

export const documentImage = (part: Extract<IRInputDocumentContentPart, { type: 'image' }>): IRInputMedia => {
  if (part.transformations?.oversized_image !== undefined) {
    throw new TranslateInputException('Cannot translate document image transformations to this protocol.');
  }
  return part.image;
};
