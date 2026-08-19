// What a code block renders: the text, what a copy button copies, and the failure to name if
// the text could not be produced.

export interface RenderedBody {
  text: string;
  copyText: string;
  decodeError: string | null;
  isJson: boolean;
}
