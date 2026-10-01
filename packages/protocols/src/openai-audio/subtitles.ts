// SubRip and WebVTT, the two renderings of a transcription that are subtitle documents
// rather than JSON. Both carry exactly one thing — timed cues — so reading one is a total
// reading of it.
//
// There is no writer here, and that is the point: a subtitle rendering is carried to the
// client as the bytes the upstream sent, so nothing ever has to reproduce one. What the
// reading is for is the record and the transcript beside it.
//
// The shapes are Whisper's own writers, which is what OpenAI's `whisper-1` runs: SubRip
// numbers its cues from 1, always writes the hour component and separates the milliseconds
// with a comma; WebVTT opens with a `WEBVTT` line, drops the hour component below one hour
// and separates the milliseconds with a period. Both terminate every cue with a blank line.
// Every one of those is a convention rather than a rule, which is why reading is written to
// accept more than Whisper writes.
// https://github.com/openai/whisper/blob/v20250625/whisper/utils.py#L238-L262

export interface OpenAIAudioTranscriptionCue {
  /** Seconds from the start of the audio. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type SubtitleDialect = 'srt' | 'vtt';

const VTT_HEADER = 'WEBVTT';

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;

const readTimestamp = (value: string, dialect: SubtitleDialect): number => {
  const parts = TIMESTAMP.exec(value.trim());
  if (parts === null) throw new Error(`${dialect} timestamp is not readable: ${JSON.stringify(value)}`);
  const [, hours, minutes, seconds, fraction] = parts;
  // A fraction shorter than three digits is still a decimal fraction of a second, so it is
  // padded on the right rather than parsed as a millisecond count.
  return Number(hours ?? '0') * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, '0')) / 1000;
};

const readCueBlock = (block: readonly string[], dialect: SubtitleDialect): OpenAIAudioTranscriptionCue => {
  // SubRip opens a cue with its ordinal and WebVTT with an optional identifier, so the
  // timing line is the one holding the arrow and the lines after it are the cue's text.
  const timingIndex = block.findIndex(line => line.includes('-->'));
  if (timingIndex < 0) throw new Error(`${dialect} cue has no timing line: ${JSON.stringify(block.join('\n'))}`);
  const [start, end] = block[timingIndex].split('-->');
  if (end === undefined) throw new Error(`${dialect} cue timing line has no end: ${JSON.stringify(block[timingIndex])}`);
  return {
    start: readTimestamp(start, dialect),
    end: readTimestamp(end, dialect),
    text: block.slice(timingIndex + 1).join('\n'),
  };
};

export const parseSubtitleDocument = (dialect: SubtitleDialect, document: string): readonly OpenAIAudioTranscriptionCue[] => {
  const lines = document.replaceAll('\r\n', '\n').split('\n');
  if (dialect === 'vtt') {
    // The signature may carry a byte order mark and may be followed by header metadata on
    // the same line. https://www.w3.org/TR/webvtt1/#webvtt-file-body
    const signature = lines.shift()?.replace('﻿', '') ?? '';
    if (!signature.startsWith(VTT_HEADER)) {
      throw new Error(`WebVTT document must open with ${VTT_HEADER}: ${JSON.stringify(signature)}`);
    }
  }

  // A blank line ends a cue in both dialects, which is what makes a cue's own text able to
  // span several lines.
  const blocks: string[][] = [];
  let open: string[] | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      open = null;
      continue;
    }
    if (open === null) {
      open = [];
      blocks.push(open);
    }
    open.push(line);
  }
  return blocks.map(block => readCueBlock(block, dialect));
};
