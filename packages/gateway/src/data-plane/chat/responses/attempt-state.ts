export class ResponsesAttemptState {
  readonly #privatePayloads = new Map<string, unknown>();
  readonly #gatewayItemIds = new Set<string>();
  #outputSource: { readonly upstreamId: string; readonly restoresItemIds: boolean } | undefined;

  begin(
    privatePayloads: ReadonlyMap<string, unknown>,
    outputSource?: { readonly upstreamId: string; readonly restoresItemIds: boolean },
  ): void {
    this.#privatePayloads.clear();
    this.#gatewayItemIds.clear();
    this.#outputSource = outputSource;
    for (const [id, payload] of privatePayloads) {
      this.#privatePayloads.set(id, structuredClone(payload));
    }
  }

  setPrivatePayload(id: string, payload: unknown): void {
    this.#gatewayItemIds.add(id);
    this.#privatePayloads.set(id, structuredClone(payload));
  }

  getPrivatePayload(id: string): unknown {
    const payload = this.#privatePayloads.get(id);
    return payload === undefined ? undefined : structuredClone(payload);
  }

  outputItemSource(id: string): { readonly upstreamId: string; readonly upstreamItemId: string } | null {
    if (
      this.#outputSource?.restoresItemIds !== true
      || this.#gatewayItemIds.has(id)
      || /_tmp_[A-Za-z0-9_-]{22}$/.test(id)
    ) return null;
    return { upstreamId: this.#outputSource.upstreamId, upstreamItemId: id };
  }
}
