let viewOf: (bytes: Bytes) => Uint8Array;

export class Bytes {
  static readonly empty = new Bytes(new Uint8Array());

  readonly #storage: Uint8Array;

  static {
    viewOf = bytes => bytes.#storage;
  }

  private constructor(storage: Uint8Array) {
    this.#storage = storage;
    Object.freeze(this);
  }

  static adopt(owned: Uint8Array): Bytes {
    const { buffer, byteOffset, byteLength } = owned;
    if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
      try {
        return new Bytes(new Uint8Array(buffer.transfer()));
      } catch (error) {
        // A non-detachable buffer (for example one backing WebAssembly memory)
        // can still be copied using its view.
        if (!(error instanceof TypeError) || buffer.detached) throw error;
      }
    }
    return this.copy(owned);
  }

  static copy(view: Uint8Array): Bytes {
    return new Bytes(new Uint8Array(view));
  }

  static fromUtf8(text: string): Bytes {
    return new Bytes(new TextEncoder().encode(text));
  }

  static concat(parts: readonly Bytes[]): Bytes {
    const storage = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      storage.set(part.#storage, offset);
      offset += part.byteLength;
    }
    return new Bytes(storage);
  }

  get byteLength(): number {
    return this.#storage.byteLength;
  }

  utf8(): string {
    return new TextDecoder().decode(this.#storage);
  }

  subarray(start?: number, end?: number): Bytes {
    return new Bytes(this.#storage.subarray(start, end));
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.#storage);
  }

  equals(other: Bytes): boolean {
    return this.byteLength === other.byteLength
      && this.#storage.every((byte, index) => byte === other.#storage[index]);
  }
}

export { viewOf };
