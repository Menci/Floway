import { TextDecoder } from 'node:util';

export interface SourceSection {
  name: string;
  file: string;
  start?: string;
  end?: string;
  append?: string;
}

export const decodeUtf8Source = (bytes: Uint8Array, file: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${file} is not valid UTF-8`, { cause: error });
  }
};

const uniqueBoundaryOffset = (source: string, boundary: string, name: string): number => {
  const index = source.indexOf(boundary);
  if (index === -1) throw new Error(`${name} does not contain boundary ${JSON.stringify(boundary)}`);
  if (source.includes(boundary, index + boundary.length)) {
    throw new Error(`${name} contains boundary ${JSON.stringify(boundary)} more than once`);
  }
  return index;
};

export const renderSourceSection = (section: SourceSection, source: string): string => {
  const start = section.start === undefined ? 0 : uniqueBoundaryOffset(source, section.start, section.name);
  const end = section.end === undefined ? source.length : uniqueBoundaryOffset(source, section.end, section.name);
  if (end < start) {
    throw new Error(`${section.name} end boundary ${JSON.stringify(section.end)} occurs before its start boundary`);
  }
  return source.slice(start, end) + (section.append ?? '');
};
