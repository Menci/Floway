export class ResponsesAttemptState {
  readonly #privatePayloads = new Map<string, unknown>();

  begin(privatePayloads: ReadonlyMap<string, unknown>, itemIdMap: ReadonlyMap<string, string>): void {
    this.#privatePayloads.clear();
    for (const [id, payload] of privatePayloads) {
      this.#privatePayloads.set(itemIdMap.get(id) ?? id, structuredClone(payload));
    }
  }

  setPrivatePayload(id: string, payload: unknown): void {
    this.#privatePayloads.set(id, structuredClone(payload));
  }

  getPrivatePayload(id: string): unknown {
    const payload = this.#privatePayloads.get(id);
    return payload === undefined ? undefined : structuredClone(payload);
  }
}
