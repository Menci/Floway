export interface PureTextPart {
  readonly type?: string;
  readonly text: string;
}

export const isPureTextPart = <Part extends object>(value: Part, types: readonly string[] = [], emptyFields: readonly string[] = []): value is Part & PureTextPart => {
  if (!('text' in value) || typeof value.text !== 'string') return false;
  if (types.length > 0 && (!('type' in value) || typeof value.type !== 'string' || !types.includes(value.type))) return false;
  return Object.entries(value).every(([key, field]) => key === 'text' || (key === 'type' && types.length > 0)
    || (emptyFields.includes(key) && (field == null || (Array.isArray(field) && field.length === 0))));
};

type TextRun<Part extends object> = { parts: (Part & PureTextPart)[]; text: string; type?: string } | { parts: Part[]; text?: undefined };

const adjacentTextRuns = <Part extends object>(parts: readonly Part[], isPure: (part: Part) => part is Part & PureTextPart): TextRun<Part>[] => {
  const runs: TextRun<Part>[] = [];
  for (const part of parts) {
    const previous = runs.at(-1);
    if (isPure(part)) {
      if (previous?.text !== undefined && previous.type === part.type) {
        previous.parts.push(part);
        previous.text += part.text;
      } else runs.push({ parts: [part], text: part.text, type: part.type });
    } else runs.push({ parts: [part] });
  }
  return runs;
};

export const canonicalTextParts = <Part extends object>(parts: readonly Part[], isPure: (part: Part) => part is Part & PureTextPart): Part[] =>
  adjacentTextRuns(parts, isPure).map(run => run.text === undefined || run.parts.length === 1 ? run.parts[0] : { ...run.parts[0], text: run.text });
