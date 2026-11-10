import { expectTypeOf, test } from 'vitest';

import { createFieldState, type ReadFieldState, type ReadFieldStates } from '../../../src/round-trip/reference/reference-builder.ts';
import type { JSONRule, TextRule, ReferenceState, ReferenceableValue } from '../../../src/round-trip/reference/reference-type.ts';

test('derives selected text, JSON, and sparse state leaves from one nested rule', () => {
  type Source = {
    text: string;
    items: { text: string; type: 'summary_text' }[];
    input: { ordered: number };
    encrypted_content: string;
  };
  type Reference = { readonly id: 'reference' };
  type Rule = {
    text: TextRule;
    items: [{ text: TextRule }];
    input: JSONRule;
  };

  expectTypeOf<ReferenceableValue<Source, Rule, Reference>>().toEqualTypeOf<{
    text: string | Reference;
    items: { text: string | Reference; type: 'summary_text' }[];
    input: { ordered: number } | Reference;
    encrypted_content: string;
  }>();
  expectTypeOf<ReferenceState<Source, Rule, ReadFieldStates>>().toEqualTypeOf<{
    text?: ReadFieldState<'text'>;
    items?: Array<{ text?: ReadFieldState<'text'> } | undefined>;
    input?: ReadFieldState<'json'>;
  }>();
  const jsonState = createFieldState('json');
  // @ts-expect-error A JSON field state cannot occupy a text rule leaf.
  const invalid: ReferenceState<Source, Rule, ReadFieldStates> = { text: jsonState };
  expectTypeOf(invalid).toMatchTypeOf<ReferenceState<Source, Rule, ReadFieldStates>>();
});
