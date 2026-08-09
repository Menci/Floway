# Reads a managed document as UTF-8 on every host.
#
# `Get-Content -Raw` decodes with the system ANSI code page on Windows
# PowerShell 5.1 and with UTF-8 on 6+, so on a stock Windows box a document
# holding a font name, a path or a localized string comes back mis-decoded,
# gets written out again as UTF-8, and is mojibake from then on. Nothing would
# refuse it: the mis-decoded text is still valid JSON. The Bash half passes the
# bytes through untouched, so the two halves would disagree about one file.
#
# What settles it is that the encoding is an argument rather than a host
# setting: measured on an ACP-65001 box, reading `café.json` through CP1252
# still yields the `Ã©` mojibake while this reader yields `é`. (The two runtimes
# also differ on a truncated trailing sequence — 5.1 drops it, 7.6 substitutes
# U+FFFD — but that is a decoder detail, not the gap this closes.) The writer
# beside this uses the same encoding, and ReadAllText strips a BOM if present.
function Get-SetupFileText {
  param([string]$Path)
  return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}

# Does this JSON text open with the expected root — `{` for an object, `[` for
# an array, whichever the caller asks for? Asked of the text rather than of the decoded value because
# ConvertFrom-Json unwraps a top-level one-element array into a bare object and
# yields `$null` for both `[]` and an empty file, so the decoded value cannot
# tell those shapes apart. A zero-byte file, which the reader above returns as
# the empty string, opens with nothing and is therefore no shape at all.
function Test-SetupJsonRoot {
  param([string]$Text, [char]$Open)
  return $Text.TrimStart().StartsWith($Open)
}

# Classifies a JSON text the way the Bash half's toolchain does: 'jsonc' for a
# construct the editor accepts and jq does not, 'invalid' for anything outside
# JSON's grammar, 'ok' otherwise.
#
# Both are needed because ConvertFrom-Json cannot be the arbiter. jq implements
# RFC 8259; PowerShell 6+ decodes through Newtonsoft, which takes single-quoted
# strings, unquoted keys, trailing commas and any Unicode whitespace — so a
# document jq refuses would be parsed here and written back in canonical form,
# one half stopping and the other rewriting the operator's file. Windows
# PowerShell 5.1 is stricter still and refuses some of these itself, which is
# why the answer cannot be left to whichever decoder the host happens to have.
#
# Strings are walked rather than stripped by regex, because a value like a model
# id or a URL contains `//` legitimately. The JSONC arm mirrors
# _json_has_jsonc_syntax; the strict arm mirrors what jq accepts.
function Get-SetupJsonVerdict {
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
      if ($next -eq '/' -or $next -eq '*') { return 'jsonc' }
    }
    if ($ch -eq ',') { $comma = $true; continue }
    # JSON's whitespace, not .NET's: `[char]::IsWhiteSpace` also skips U+00A0,
    # the vertical tab, the form feed and U+2028, none of which JSON allows.
    if ($ch -eq ' ' -or $ch -eq "`t" -or $ch -eq "`r" -or $ch -eq "`n") { continue }
    if ($comma -and ($ch -eq '}' -or $ch -eq ']')) { return 'jsonc' }
    $comma = $false
    if ($ch -eq '"') { $inString = $true; continue }
    # Everything JSON allows outside a string: structure, and the characters
    # numbers and the three literals are spelled with. Anything else — a stray
    # form feed, a single quote opening a string, a letter starting an unquoted
    # key — is a document jq refuses, and refusing it here is what keeps the two
    # halves from disagreeing about one file.
    if ('{}[]:'.IndexOf($ch) -lt 0 -and '0123456789+-.eE'.IndexOf($ch) -lt 0 -and 'truefalsn'.IndexOf($ch) -lt 0) {
      return 'invalid'
    }
  }
  return 'ok'
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
# and `[null]` has to stay one element rather than collapse to an empty list.
# No caller on this branch is fed a document that can contain one — Zed's is
# the gateway's own projection — but a helper that silently drops null elements
# is one the next caller cannot reason about. Measured on 5.1.26100.8875 and
# pwsh 7.7: both give 2, 1, 1, 2, 0 and 2 elements for a two-object array, a
# one-object array, `[null]`, `[null,null]`, `[]` and `[1,2]`.
function ConvertFrom-SetupJsonArray {
  param([string]$Text)
  $parsed = ConvertFrom-Json -InputObject $Text
  if ($parsed -is [System.Array]) { return $parsed }
  # A lone element, `$null` included, stays one element through the return.
  return ,$parsed
}
