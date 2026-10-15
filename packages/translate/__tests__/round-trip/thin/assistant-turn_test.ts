import { expectTypeOf, test } from 'vitest';

import type { JSONRule, TextRule, ThinState, ThinValue } from '../../../src/round-trip/thin/assistant-turn.ts';
import { createFieldState, type FieldState, type FieldStates } from '../../../src/round-trip/thin/reference-builder.ts';

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

  expectTypeOf<ThinValue<Source, Rule, Reference>>().toEqualTypeOf<{
    text: string | Reference;
    items: { text: string | Reference; type: 'summary_text' }[];
    input: { ordered: number } | Reference;
    encrypted_content: string;
  }>();
  expectTypeOf<ThinState<Source, Rule, FieldStates>>().toEqualTypeOf<{
    text?: FieldState<'text'>;
    items?: Array<{ text?: FieldState<'text'> } | undefined>;
    input?: FieldState<'json'>;
  }>();
  const jsonState = createFieldState('json');
  // @ts-expect-error A JSON field state cannot occupy a text rule leaf.
  const invalid: ThinState<Source, Rule, FieldStates> = { text: jsonState };
  expectTypeOf(invalid).toMatchTypeOf<ThinState<Source, Rule, FieldStates>>();
});
