import ChangeDetails from 'imask/esm/core/change-details';
import type { Direction } from 'imask/esm/core/utils';
import Masked from 'imask/esm/masked/base';
import type { AppendFlags, MaskedOptions, MaskedState } from 'imask/esm/masked/base';

export type DurationUnit = 's' | 'm' | 'h' | 'd';
export type MaskedRetentionValue = number | 'off' | null;

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;
const DURATION_UNITS = Object.keys(UNIT_SECONDS) as DurationUnit[];
const CANONICAL_UNITS = ['d', 'h', 'm', 's'] as const;

export const durationPartsForSeconds = (seconds: number): { draft: string; unit: DurationUnit } => {
  const unit = CANONICAL_UNITS.find(candidate => seconds % UNIT_SECONDS[candidate] === 0)!;
  return { draft: String(seconds / UNIT_SECONDS[unit]), unit };
};

interface DurationState {
  draft: string;
  kind: 'duration';
  unit: DurationUnit;
}

interface OffState {
  kind: 'off';
}

type RetentionState = DurationState | OffState;

export type FormatDuration = (draft: string, unit: DurationUnit) => string;

export interface MaskedRetentionOptions extends MaskedOptions<MaskedRetention> {
  defaultUnit: DurationUnit;
  formatDuration: FormatDuration;
  offLabel: string;
}

const durationState = (draft: string, unit: DurationUnit): DurationState => ({ draft, kind: 'duration', unit });

export class MaskedRetention extends Masked<MaskedRetentionValue> {
  declare defaultUnit: DurationUnit;
  declare formatDuration: FormatDuration;
  declare offLabel: string;
  declare overwrite: boolean | 'shift' | undefined;
  declare eager: boolean | 'remove' | 'append' | undefined;
  declare skipInvalid: boolean | undefined;
  declare autofix: boolean | 'pad' | undefined;

  private retentionState: RetentionState = durationState('', 's');

  constructor(options: MaskedRetentionOptions) {
    super(options);
    this.retentionState = durationState('', this.defaultUnit);
  }

  override reset() {
    this.retentionState = durationState('', this.defaultUnit);
  }

  override get state(): MaskedState & { retention: RetentionState } {
    return {
      _rawInputValue: this.rawInputValue,
      _value: this.value,
      retention: this.retentionState.kind === 'off' ? { kind: 'off' } : { ...this.retentionState },
    };
  }

  override set state(next: MaskedState & { retention: RetentionState }) {
    this.retentionState = next.retention.kind === 'off' ? { kind: 'off' } : { ...next.retention };
  }

  override get value(): string {
    if (this.retentionState.kind === 'off') return this.offLabel;
    return this.retentionState.draft === ''
      ? ''
      : /^\d+$/.test(this.retentionState.draft)
        ? this.formatDuration(this.retentionState.draft, this.retentionState.unit)
        : this.retentionState.draft;
  }

  override set value(text: string) {
    if (text === '') {
      this.reset();
      return;
    }
    this.retentionState = this.parseDisplay(text) ?? durationState(text.trim(), this.defaultUnit);
  }

  override get displayValue(): string {
    return this.value;
  }

  // InputMask history persists only unmaskedValue and selection, so the unit
  // and the off state are part of this lossless representation.
  // https://github.com/uNmAnNeR/imaskjs/blob/a02a14b642f70b335e24789e8a187857473a21a5/packages/imask/src/controls/input-history.ts#L4-L49
  override get unmaskedValue(): string {
    if (this.retentionState.kind === 'off') return 'off';
    return this.retentionState.draft === '' ? '' : `${this.retentionState.unit}:${this.retentionState.draft}`;
  }

  override set unmaskedValue(text: string) {
    if (text === '') {
      this.reset();
      return;
    }
    if (text === 'off') {
      this.retentionState = { kind: 'off' };
      return;
    }
    const unit = text[0] as DurationUnit;
    if (!DURATION_UNITS.includes(unit) || text[1] !== ':') {
      throw new TypeError(`Invalid retention mask state: ${text}`);
    }
    this.retentionState = durationState(text.slice(2), unit);
  }

  override get rawInputValue(): string {
    return this.unmaskedValue;
  }

  override set rawInputValue(text: string) {
    this.unmaskedValue = text;
  }

  override get typedValue(): MaskedRetentionValue {
    if (this.retentionState.kind === 'off') return 'off';
    if (!/^\d+$/.test(this.retentionState.draft)) return null;
    const seconds = Number(this.retentionState.draft) * UNIT_SECONDS[this.retentionState.unit];
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }

  override set typedValue(value: MaskedRetentionValue) {
    if (value === 'off') {
      this.retentionState = { kind: 'off' };
      return;
    }
    if (value === null) {
      this.reset();
      return;
    }
    if (value === 0) {
      this.retentionState = { kind: 'off' };
      return;
    }
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid retention: ${value}`);
    this.retentionState = this.canonicalDuration(value);
  }

  override get isComplete(): boolean {
    return this.typedValue !== null;
  }

  isSelectionEditable(start: number, end: number): boolean {
    return this.retentionState.kind === 'duration' && start <= this.amountLength && end <= this.amountLength;
  }

  override splice(
    start: number,
    deleteCount: number,
    inserted = '',
    _removeDirection?: Direction,
    _flags?: AppendFlags,
  ): ChangeDetails {
    const oldDisplay = this.displayValue;
    const end = start + deleteCount;
    const candidate = oldDisplay.slice(0, start) + inserted + oldDisplay.slice(end);
    const replacesEverything = start === 0 && end === oldDisplay.length;
    let cursor = start;

    if (candidate === '') {
      this.reset();
      cursor = 0;
    } else {
      const currentDuration = this.retentionState.kind === 'duration' ? this.retentionState : null;
      const nextUnit = currentDuration === null ? null : this.unitToken(inserted);
      if (currentDuration !== null
        && nextUnit !== null
        && (start >= this.amountLength || end > this.amountLength)
        && !replacesEverything) {
        const seconds = Number(currentDuration.draft) * UNIT_SECONDS[nextUnit];
        this.retentionState = Number.isSafeInteger(seconds) && seconds > 0
          ? this.canonicalDuration(seconds)
          : durationState(currentDuration.draft, nextUnit);
        cursor = this.amountLength;
      } else if (this.retentionState.kind === 'off') {
        this.retentionState = this.parseDisplay(inserted) ?? durationState(inserted.trim(), this.defaultUnit);
        cursor = this.amountLength;
      } else {
        const parsed = this.parseDisplay(candidate);
        if (parsed !== null) {
          this.retentionState = parsed;
          cursor = this.amountCursor(start + inserted.length);
        } else if (replacesEverything) {
          this.retentionState = this.parseDisplay(inserted) ?? durationState(inserted.trim(), this.defaultUnit);
          cursor = this.amountLength;
        } else if (start <= this.amountLength && end <= this.amountLength) {
          const amountStart = Math.min(start, this.amountLength);
          const amountEnd = Math.min(end, this.amountLength);
          const draft = this.retentionState.draft.slice(0, amountStart)
            + inserted
            + this.retentionState.draft.slice(amountEnd);
          this.retentionState = this.durationForDraft(draft, this.retentionState.unit);
          cursor = this.amountCursor(amountStart + inserted.length);
        }
      }
    }

    // ChangeDetails.offset is inserted.length + tailShift. The model applies
    // this replacement atomically, so tailShift carries the absolute caret move.
    return new ChangeDetails({ tailShift: cursor - start });
  }

  private get amountLength(): number {
    return this.retentionState.kind === 'duration' ? this.retentionState.draft.length : 0;
  }

  private amountCursor(candidate: number): number {
    return Math.min(candidate, this.amountLength);
  }

  private canonicalDuration(seconds: number): DurationState {
    const { draft, unit } = durationPartsForSeconds(seconds);
    return durationState(draft, unit);
  }

  private durationForDraft(draft: string, unit: DurationUnit): RetentionState {
    if (!/^\d+$/.test(draft)) return durationState(draft, unit);
    const seconds = Number(draft) * UNIT_SECONDS[unit];
    if (seconds === 0) return { kind: 'off' };
    return Number.isSafeInteger(seconds) && seconds > 0
      ? this.canonicalDuration(seconds)
      : durationState(draft, unit);
  }

  private parseDisplay(text: string): RetentionState | null {
    const trimmed = text.trim();
    if (trimmed === this.offLabel) return { kind: 'off' };

    const shorthand = /^(\d+)\s*([smhd])?$/i.exec(trimmed);
    if (shorthand) {
      const unit = (shorthand[2]?.toLowerCase() as DurationUnit | undefined) ?? this.defaultUnit;
      return this.durationForDraft(shorthand[1], unit);
    }

    const amount = /^(\d+)/.exec(trimmed)?.[1];
    if (amount !== undefined) {
      const unit = DURATION_UNITS.find(candidate => this.formatDuration(amount, candidate) === trimmed);
      if (unit !== undefined) return this.durationForDraft(amount, unit);
    }

    for (const unit of DURATION_UNITS) {
      const labels = ['1', '2'].map(example => this.formatDuration(example, unit).slice(example.length).trim());
      const label = labels.find(candidate => trimmed.endsWith(` ${candidate}`));
      if (label !== undefined) return durationState(trimmed.slice(0, -label.length).trim(), unit);
    }
    return null;
  }

  private unitToken(text: string): DurationUnit | null {
    const shorthand = /^\s*([smhd])\s*$/i.exec(text)?.[1]?.toLowerCase() as DurationUnit | undefined;
    if (shorthand !== undefined) return shorthand;
    return DURATION_UNITS.find(unit => {
      const labels = ['1', '2'].map(amount => this.formatDuration(amount, unit).slice(amount.length).trim());
      return labels.includes(text.trim());
    }) ?? null;
  }
}
