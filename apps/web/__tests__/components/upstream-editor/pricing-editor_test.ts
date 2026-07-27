import { describe, expect, it } from "vitest";

import type { ModelPricing } from "@floway-dev/protocols/common";
import { priceFromDraft, pricingEntries, pricingIsValid, writePricingEntry } from "../../../src/components/upstream-editor/pricing-editor";

describe("pricing editor model", () => {
  it("accepts fractional pricing drafts", () => {
    expect(priceFromDraft("0.0028")).toBe(0.0028);
    expect(priceFromDraft("0.")).toBe(0);
    expect(priceFromDraft(".")).toBeUndefined();
    expect(priceFromDraft("-1")).toBeUndefined();
  });

  it("distinguishes absent pricing from an invalid empty catalog", () => {
    expect(pricingIsValid(undefined)).toBe(true);
    expect(pricingIsValid({ entries: [] })).toBe(false);
  });

  it("keeps selectors and rates when replacing an entry", () => {
    const pricing: ModelPricing = {
      entries: [
        { rates: { input: 1, output: 2 } },
        { selector: { serviceTier: "priority" }, rates: { input: 3, output: 4 } },
      ],
    };
    const next = writePricingEntry(pricing, 1, (entry) => ({
      ...entry,
      selector: { ...entry.selector, inputTokens: { operator: "gte", value: 272_000 } },
    }));
    expect(next).toEqual({
      entries: [
        { rates: { input: 1, output: 2 } },
        {
          selector: { serviceTier: "priority", inputTokens: { operator: "gte", value: 272_000 } },
          rates: { input: 3, output: 4 },
        },
      ],
    });
    expect(pricingIsValid(next)).toBe(true);
  });

  it("clones entries before editing", () => {
    const pricing: ModelPricing = { entries: [{ rates: { input: 1 } }] };
    const entries = pricingEntries(pricing);
    (entries[0]!.rates as { input?: number }).input = 9;
    expect(pricing.entries[0]!.rates.input).toBe(1);
  });
});
