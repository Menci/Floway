import type { DumpBody } from "@floway-dev/gateway/dump-types";

export interface RenderedBody {
  text: string;
  copyText: string;
  decodeError: string | null;
  isJson: boolean;
}

export const EMPTY_BODY: RenderedBody = { text: "", copyText: "", decodeError: null, isJson: false };

export function contentTypeOf(headers: Array<[string, string]>): string {
  return headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
}

export function renderBody(body: DumpBody, contentType: string): RenderedBody {
  if (!body.data) return EMPTY_BODY;
  if (contentType.toLowerCase().startsWith("multipart/") && body.encoding === "base64") {
    const multipart = renderMultipart(body.data, contentType);
    if (multipart !== null) {
      return { text: multipart, copyText: body.data, decodeError: null, isJson: false };
    }
  }

  let text = body.data;
  if (body.encoding === "base64") {
    try {
      const binary = atob(body.data);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return {
        text: body.data,
        copyText: body.data,
        decodeError: error instanceof Error ? error.message : String(error),
        isJson: false,
      };
    }
  }

  try {
    const pretty = JSON.stringify(JSON.parse(text) as unknown, null, 2);
    return { text: pretty, copyText: pretty, decodeError: null, isJson: true };
  } catch {
    return { text, copyText: text, decodeError: null, isJson: false };
  }
}

function renderMultipart(base64: string, contentType: string): string | null {
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;

  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const wire = new TextDecoder("latin1").decode(bytes);
    const chunks = wire.split(`--${boundary}`);
    if (chunks.length < 3) return null;

    const rendered = chunks.slice(1, -1).map((chunk) => {
      const part = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
      const separator = part.indexOf("\r\n\r\n");
      if (separator < 0) throw new Error("Malformed multipart body");
      const headers = part.slice(0, separator);
      const data = part.slice(separator + 4);
      const type = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
      const textual = !type || /^(text\/|application\/(json|.*\+json|xml|.*\+xml|x-www-form-urlencoded))/i.test(type);
      if (textual) return `${headers}\r\n\r\n${new TextDecoder().decode(Uint8Array.from(data, (c) => c.charCodeAt(0)))}`;
      const encoded = btoa(data).replace(/.{76}(?=.)/g, "$&\n");
      return `${headers}\r\n\r\n[binary, ${data.length} bytes, content-type=${type}]\r\n${encoded}`;
    });
    return `--${boundary}\r\n${rendered.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
  } catch {
    return null;
  }
}
