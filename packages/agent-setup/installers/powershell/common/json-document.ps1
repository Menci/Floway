# Does this JSON text open with the expected root — `{` for an object, `[` for
# an array? Asked of the text rather than of the decoded value because
# ConvertFrom-Json unwraps a top-level one-element array into a bare object and
# yields `$null` for both `[]` and an empty file, so the decoded value cannot
# tell those shapes apart. A zero-byte file, which `Get-Content -Raw` returns as
# `$null` and the parameter binder turns into the empty string, opens with
# nothing and is therefore no shape at all.
function Test-SetupJsonRoot {
  param([string]$Text, [char]$Open)
  return $Text.TrimStart().StartsWith($Open)
}

# Does this JSON text use a JSONC construct — a `//` or `/*` comment, or a comma
# before a closing brace or bracket? Both editors read their managed document
# with a parser that accepts these, so they are the operator's content, but jq
# has no lenient mode and refuses the file. ConvertFrom-Json accepts a trailing
# comma and would go on to rewrite the document without it, so this is what
# keeps the two halves from reaching opposite verdicts on one file. Strings are
# walked rather than stripped by regex, because a value like a model id or a URL
# contains `//` legitimately. Mirrors _json_has_jsonc_syntax.
function Test-SetupJsonHasJsoncSyntax {
  param([string]$Text)
  $inString = $false
  $escaped = $false
  $comma = $false
  for ($i = 0; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    if ($inString) {
      if ($escaped) { $escaped = $false }
      elseif ($ch -eq '\') { $escaped = $true }
      elseif ($ch -eq '"') { $inString = $false }
      continue
    }
    if ($ch -eq '/' -and $i + 1 -lt $Text.Length) {
      $next = $Text[$i + 1]
      if ($next -eq '/' -or $next -eq '*') { return $true }
    }
    if ($ch -eq ',') { $comma = $true; continue }
    # JSON whitespace, not .NET's: `[char]::IsWhiteSpace` also accepts U+00A0
    # and friends, which the Bash scanner does not, and the two halves have to
    # decide the same way about the same bytes.
    if ($ch -eq ' ' -or $ch -eq "`t" -or $ch -eq "`r" -or $ch -eq "`n") { continue }
    if ($comma -and ($ch -eq '}' -or $ch -eq ']')) { return $true }
    $comma = $false
    if ($ch -eq '"') { $inString = $true }
  }
  return $false
}

function Set-SetupProp {
  param($Target, [string]$Name, $Value)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.$Name = $Value }
  else { $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Remove-SetupProp {
  param($Target, [string]$Name)
  if ($Target.PSObject.Properties.Name -contains $Name) { $Target.PSObject.Properties.Remove($Name) }
}

# A null optional value means "remove this managed key"; any other value is set.
function Set-SetupOptionalProp {
  param($Target, [string]$Name, $Value)
  if ($null -eq $Value) { Remove-SetupProp $Target $Name } else { Set-SetupProp $Target $Name $Value }
}

# A top-level JSON array, as a flat array on both PowerShell versions.
#
# Windows PowerShell 5.1 hands the whole array back as one object where 7 hands
# back its elements, so `@($text | ConvertFrom-Json)` is a one-element array
# holding the real one there and the real one here. The nested form is not
# merely a wrong count: ConvertTo-Json writes an inner collection as
# `{"value":[…],"Count":n}`, so an editor reads an object where its schema
# requires a list and drops the whole entry.
#
# Decided by type rather than by enumerating, because `foreach` skips a `$null`
# and `[null]` has to stay one element — it is a document to refuse, not an
# empty list. Measured on 5.1.26100.8875 and pwsh 7.7: both give 2, 1, 1, 2, 0
# and 2 elements for a two-object array, a one-object array, `[null]`,
# `[null,null]`, `[]` and `[1,2]`.
function ConvertFrom-SetupJsonArray {
  param([string]$Text)
  $parsed = ConvertFrom-Json -InputObject $Text
  if ($parsed -is [System.Array]) { return $parsed }
  # A lone element, `$null` included, stays one element through the return.
  return ,$parsed
}
