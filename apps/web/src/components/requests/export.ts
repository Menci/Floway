import type { RequestArchive } from './archive';

const download = (body: Blob, name: string): void => {
  const url = URL.createObjectURL(body);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const downloadArchive = ({ id, contents }: RequestArchive): void => {
  download(new Blob([contents], { type: 'application/x-ndjson' }), `floway-request-${id}.ndjson`);
};

export const exportArchives = (archives: readonly RequestArchive[], separate: boolean): Blob => {
  if (!separate) return new Blob([JSON.stringify({ records: archives })], { type: 'application/json' });
  // POSIX ustar keeps each NDJSON event space in a separate file.
  // https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const { id, contents } of archives) {
    const data = encoder.encode(contents);
    const header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    const name = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    write(0, `${name}.ndjson`);
    write(100, '0000644\0');
    write(108, '0000000\0');
    write(116, '0000000\0');
    write(124, `${data.length.toString(8).padStart(11, '0')}\0`);
    write(136, '00000000000\0');
    write(148, '        ');
    write(156, '0');
    write(257, 'ustar\0');
    write(263, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data, new Uint8Array((512 - data.length % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  return new Blob(chunks, { type: 'application/x-tar' });
};

export const downloadArchives = (archives: readonly RequestArchive[], separate: boolean): void => {
  download(exportArchives(archives, separate), `floway-requests-${new Date().toISOString().slice(0, 10)}.${separate ? 'tar' : 'json'}`);
};
