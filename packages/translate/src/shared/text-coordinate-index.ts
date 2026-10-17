import type { IRUTF16TextRange } from '../ir/types.ts';

type TextCoordinateMode = 'code-point-to-utf16' | 'utf16-to-code-point' | 'utf16-to-utf8';

const INVALID_BOUNDARY = 0xffff_ffff;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
const isSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdfff;

const utf8Width = (point: number): number => point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;

class GrowableUint32Array {
  #values = new Uint32Array(16);
  #length = 0;

  get length(): number { return this.#length; }

  get(index: number): number {
    if (index < 0 || index >= this.#length) throw new RangeError(`Coordinate index is out of range: ${index}`);
    return this.#values[index];
  }

  set(index: number, value: number): void {
    if (index < 0 || index >= this.#length) throw new RangeError(`Coordinate index is out of range: ${index}`);
    this.#values[index] = value;
  }

  push(value: number): void {
    if (this.#length === this.#values.length) {
      const grown = new Uint32Array(this.#values.length * 2);
      grown.set(this.#values);
      this.#values = grown;
    }
    this.#values[this.#length++] = value;
  }

  truncate(length: number): void {
    if (length < 0 || length > this.#length) throw new RangeError(`Coordinate index length is out of range: ${length}`);
    this.#length = length;
  }
}

// A text starts without an index. Its protocol owner creates one when the first citation
// needs coordinates, then forwards every later text append to the same instance.
export class TextCoordinateIndex {
  readonly #mode: TextCoordinateMode;
  readonly #boundaries = new GrowableUint32Array();
  #utf16Length = 0;
  #coordinate = 0;
  #unpairedSurrogates = 0;
  #trailingHighSurrogate = false;

  private constructor(mode: TextCoordinateMode, text: string) {
    this.#mode = mode;
    this.#boundaries.push(0);
    this.append(text);
  }

  static codePointsToUTF16(text: string): TextCoordinateIndex {
    return new TextCoordinateIndex('code-point-to-utf16', text);
  }

  static utf16ToCodePoints(text: string): TextCoordinateIndex {
    return new TextCoordinateIndex('utf16-to-code-point', text);
  }

  static utf16ToUTF8(text: string): TextCoordinateIndex {
    return new TextCoordinateIndex('utf16-to-utf8', text);
  }

  get codePointLength(): number {
    if (this.#mode !== 'code-point-to-utf16') throw new TypeError('Text coordinate index does not map code points to UTF-16');
    return this.#boundaries.length - 1;
  }

  assertUTF16Length(length: number): void {
    if (length !== this.#utf16Length) throw new TypeError(`Text coordinate index covers ${this.#utf16Length} UTF-16 units, not ${length}`);
  }

  append(delta: string): void {
    if (delta === '') return;
    let remainder = delta;
    if (this.#trailingHighSurrogate && isLowSurrogate(delta.charCodeAt(0))) {
      if (this.#mode === 'code-point-to-utf16') {
        this.#boundaries.truncate(this.#boundaries.length - 1);
        this.#utf16Length++;
        this.#boundaries.push(this.#utf16Length);
      } else {
        this.#boundaries.set(this.#utf16Length, INVALID_BOUNDARY);
        this.#utf16Length++;
        if (this.#mode === 'utf16-to-utf8') {
          this.#coordinate += 1;
          this.#unpairedSurrogates--;
        }
        this.#boundaries.push(this.#coordinate);
      }
      remainder = delta.slice(1);
    }

    for (const scalar of remainder) {
      const point = scalar.codePointAt(0)!;
      if (this.#mode === 'code-point-to-utf16') {
        this.#utf16Length += scalar.length;
        this.#boundaries.push(this.#utf16Length);
        continue;
      }

      if (scalar.length === 2) this.#boundaries.push(INVALID_BOUNDARY);
      this.#utf16Length += scalar.length;
      if (this.#mode === 'utf16-to-code-point') this.#coordinate++;
      else {
        this.#coordinate += utf8Width(point);
        if (scalar.length === 1 && isSurrogate(point)) this.#unpairedSurrogates++;
      }
      this.#boundaries.push(this.#coordinate);
    }
    this.#trailingHighSurrogate = isHighSurrogate(delta.charCodeAt(delta.length - 1));
  }

  codePointRangeToIR(start: number, end: number): IRUTF16TextRange {
    if (this.#mode !== 'code-point-to-utf16') throw new TypeError('Text coordinate index does not map code points to UTF-16');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new RangeError('Invalid code-point range');
    if (end >= this.#boundaries.length) throw new RangeError('Code-point range exceeds text');
    return { start: this.#boundaries.get(start), end_exclusive: this.#boundaries.get(end) };
  }

  irRangeToCodePoints(range: IRUTF16TextRange): { start: number; end: number } {
    if (this.#mode !== 'utf16-to-code-point') throw new TypeError('Text coordinate index does not map UTF-16 to code points');
    const [start, end] = this.#utf16Range(range);
    return { start, end };
  }

  irRangeToUTF8(range: IRUTF16TextRange): { start: number; end: number } {
    if (this.#mode !== 'utf16-to-utf8') throw new TypeError('Text coordinate index does not map UTF-16 to UTF-8');
    if (this.#unpairedSurrogates !== 0) throw new TypeError('GenerateContent byte coordinates require well-formed Unicode');
    const [start, end] = this.#utf16Range(range);
    return { start, end };
  }

  #utf16Range(range: IRUTF16TextRange): readonly [number, number] {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end_exclusive)
      || range.start < 0 || range.end_exclusive < range.start || range.end_exclusive > this.#utf16Length) {
      throw new RangeError('IR range is outside text or splits a surrogate pair');
    }
    const start = this.#boundaries.get(range.start);
    const end = this.#boundaries.get(range.end_exclusive);
    if (start === INVALID_BOUNDARY || end === INVALID_BOUNDARY) throw new RangeError('IR range is outside text or splits a surrogate pair');
    return [start, end];
  }
}
