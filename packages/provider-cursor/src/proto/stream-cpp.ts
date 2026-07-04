/**
 * Cursor StreamCpp (Tab / Copilot++) request encoding + response decoding.
 *
 * Field numbers from the reversed agent/aiserver v1 protos (cursor-byok), and
 * the minimal populated field set that avoids the server's "internal error" is
 * mirrored from the working reference clients (daniprol/cursor-tabcomplete,
 * wisdgod/cursor-tab): current_file + a stub file_diff_histories entry +
 * cpp_intent_info + timestamps. Images/LSP/context are sent empty.
 */

import { TEXT_DECODER, parseProtoFields } from './decoding.ts';
import { concatBytes, encodeBoolField, encodeDoubleField, encodeInt32Field, encodeMessageField, encodeStringField } from './encoding.ts';

export interface StreamCppRequestInput {
  relativePath: string;
  contents: string;
  cursorLine: number; // 0-based
  cursorColumn: number; // 0-based
  languageId: string;
  modelName: string;
  workspaceRootPath?: string;
  /** Recent-edit hint; a non-empty stub keeps the server from erroring. */
  diffHistory?: string[];
}

// CurrentFileInfo: path=1, contents=2, cursor_position=3, language_id=5,
// total_number_of_lines=8, contents_start_at_line=9, workspace_root_path=19,
// line_ending=20. CursorPosition: line=1, column=2.
const encodeCurrentFileInfo = (input: StreamCppRequestInput): Uint8Array => {
  const cursorPosition = concatBytes(encodeInt32Field(1, input.cursorLine), encodeInt32Field(2, input.cursorColumn));
  const parts: Uint8Array[] = [
    encodeStringField(1, input.relativePath),
    encodeStringField(2, input.contents),
    encodeMessageField(3, cursorPosition),
    encodeStringField(5, input.languageId),
    encodeInt32Field(8, input.contents.split('\n').length),
    encodeInt32Field(9, 0),
    encodeStringField(19, input.workspaceRootPath ?? '/workspace'),
    encodeStringField(20, '\n'),
  ];
  return concatBytes(...parts);
};

// CppFileDiffHistory: file_name=1, diff_history=2 (repeated string).
const encodeFileDiffHistory = (fileName: string, diffs: readonly string[]): Uint8Array =>
  concatBytes(encodeStringField(1, fileName), ...diffs.map(d => encodeStringField(2, d)));

// StreamCppRequest: current_file=1, model_name=3, file_diff_histories=7,
// cpp_intent_info=16, client_time=21, time_since_request_start=23,
// time_at_request_send=24, client_timezone_offset=25, lsp_suggested_items=26,
// supports_cpt=27, supports_crlf_cpt=28.
export const encodeStreamCppRequest = (input: StreamCppRequestInput): Uint8Array => {
  const nowSec = Date.now() / 1000;
  const diffs = input.diffHistory && input.diffHistory.length > 0 ? input.diffHistory : ['1+| \n'];
  const cppIntentInfo = encodeStringField(1, 'line_change'); // CppIntentInfo.source = 1
  const parts: Uint8Array[] = [
    encodeMessageField(1, encodeCurrentFileInfo(input)),
    encodeStringField(3, input.modelName),
    encodeMessageField(7, encodeFileDiffHistory(input.relativePath, diffs)),
    encodeMessageField(16, cppIntentInfo),
    encodeDoubleField(21, nowSec),
    encodeDoubleField(23, 0),
    encodeDoubleField(24, nowSec),
    encodeDoubleField(25, 0),
    encodeMessageField(26, new Uint8Array(0)), // empty LspSuggestedItems
    encodeBoolField(27, false),
    encodeBoolField(28, false),
  ];
  return concatBytes(...parts);
};

// range_to_replace (field 11) is a 2-field LineRange on the wire — field 1 the
// start line, field 2 the end line, both 1-indexed. A live capture shows only
// fields {1,2} (cursor-unchained's proto declares a 4-field RangeToReplace with
// columns, but no column fields appear on the wire). The end line's
// inclusive/exclusive meaning is NOT fixed: it co-varies with whether `text`
// ends in a newline, so the splice in applyRewrite ignores this value and
// instead balances newline counts (see applyRewrite in completions.ts). We keep
// the field decoded for reference and future telemetry.
export interface StreamCppLineRange {
  startLineNumber: number;
  endLine: number;
}

export interface StreamCppResponseFrame {
  text: string;
  doneStream: boolean;
  doneEdit: boolean;
  beginEdit: boolean;
  rangeToReplace?: StreamCppLineRange;
  shouldRemoveLeadingEol: boolean;
}

const asBytes = (v: Uint8Array | number | bigint): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));
const asNumber = (v: Uint8Array | number | bigint): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

// StreamCppResponse: text=1, suggestion_start_line=2, done_stream=4,
// range_to_replace=11 (LineRange), cursor_prediction_target=12, done_edit=13,
// begin_edit=15, should_remove_leading_eol=16.
export const decodeStreamCppResponse = (bytes: Uint8Array): StreamCppResponseFrame => {
  const frame: StreamCppResponseFrame = { text: '', doneStream: false, doneEdit: false, beginEdit: false, shouldRemoveLeadingEol: false };
  for (const field of parseProtoFields(bytes)) {
    switch (field.fieldNumber) {
    case 1: if (field.wireType === 2) frame.text = TEXT_DECODER.decode(asBytes(field.value)); break;
    case 4: frame.doneStream = asNumber(field.value) !== 0; break;
    case 11: if (field.wireType === 2) {
      const range: StreamCppLineRange = { startLineNumber: 0, endLine: 0 };
      for (const f of parseProtoFields(asBytes(field.value))) {
        if (f.fieldNumber === 1) range.startLineNumber = asNumber(f.value);
        else if (f.fieldNumber === 2) range.endLine = asNumber(f.value);
      }
      frame.rangeToReplace = range;
      break;
    }
    case 13: frame.doneEdit = asNumber(field.value) !== 0; break;
    case 15: frame.beginEdit = asNumber(field.value) !== 0; break;
    case 16: frame.shouldRemoveLeadingEol = asNumber(field.value) !== 0; break;
    default: break;
    }
  }
  return frame;
};
