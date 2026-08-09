import pathlib

p = pathlib.Path("packages/agent-setup/__tests__/models_test.ts")
s = p.read_text()

anchor = "  it('omits max_output_tokens when the catalog announces none', () => {"
added = '''  // Copilot merges its 1M Claude variants into the base row, so the catalog
  // reports a 1M window that the bare id cannot reach — the beta that unlocks it
  // rides on the `[1m]` suffix, which is how the Claude Code half already
  // addresses this row. Without it the projected limits are a promise the
  // upstream refuses.
  it('addresses the variant whose window it reports', () => {
    const [merged, plain, already] = projectZedModels([
      catalogModel('claude-opus-4-7', { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } }),
      catalogModel('claude-sonnet-4-5', { limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 168_000, max_output_tokens: 32_000 } }),
      catalogModel('vendor/claude-opus-4-7[1m]', { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000 } }),
    ]);
    expect(merged!.name).toBe('claude-opus-4-7[1m]');
    expect(plain!.name).toBe('claude-sonnet-4-5');
    expect(already!.name).toBe('vendor/claude-opus-4-7[1m]');
    // The label the operator recognises is untouched.
    expect(merged!.display_name).toBe('claude-opus-4-7');
  });

'''
assert anchor in s
s = s.replace(anchor, added + anchor, 1)

# VS Code 半边同样要覆盖。
vs_anchor = "  it('keeps a stated zero verbatim rather than substituting a fallback', () => {"
vs_added = '''  it('addresses the variant whose window it reports', () => {
    const [merged, plain] = projectVSCodeModels([
      catalogModel('claude-opus-4-7', { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } }),
      catalogModel('claude-sonnet-4-5', { limits: { max_context_window_tokens: 200_000 } }),
    ], 'messages');
    expect(merged!.id).toBe('claude-opus-4-7[1m]');
    expect(plain!.id).toBe('claude-sonnet-4-5');
    expect(merged!.name).toBe('claude-opus-4-7');
  });

'''
assert vs_anchor in s
s = s.replace(vs_anchor, vs_added + vs_anchor, 1)
p.write_text(s)
print("ok")
