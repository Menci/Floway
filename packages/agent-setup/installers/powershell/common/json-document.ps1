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
# beside this uses the same encoding, and ReadAllText strips a UTF-8 BOM if one
# is present.
#
# What it does not do is ignore a UTF-16 or UTF-32 BOM: ReadAllText builds its
# StreamReader with byte-order-mark detection on, so such a file decodes here
# and would be rewritten as UTF-8 while jq refuses it outright. Neither editor
# writes one and no operator has reason to, but the encoding argument is the
# fallback rather than the rule.
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
# _json_has_jsonc_syntax; the strict arm is RFC 8259, which jq implements with
# two leniencies of its own — it takes `NaN`, `Infinity` and a leading `+`, all
# refused here. The reverse case is `{"":1}`, valid JSON that ConvertFrom-Json
# rejects on both versions, so the Bash half configures it and this one stops.
# Both are documents no editor writes; the parity this arm buys is over the
# constructs an operator can actually type.
function Get-SetupJsonVerdict {
  param([string]$Text)
  $inString = $false
  $escaped = $false
  $comma = $false
  # The strict verdict is carried rather than returned at once: a document with
  # both a comment and a lenient construct would otherwise answer on whichever
  # came first, while the awk scanner only looks for JSONC and always says
  # `jsonc`. The two halves have to name one cause for one file.
  $strict = $true
  for ($i = 0; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    if ($inString) {
      # A raw control character is not allowed inside a JSON string; jq refuses
      # one and both decoders take it, which is the split this arm exists for.
      if ([int]$ch -lt 0x20) { $strict = $false }
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
    # The three literals are matched as whole tokens, not by which letters they
    # are spelled with: a key like `test` or `nu` uses only those letters and
    # would otherwise pass, and Newtonsoft would then accept the unquoted key
    # and write the document back with it quoted.
    if ($ch -eq 't' -or $ch -eq 'f' -or $ch -eq 'n') {
      $literal = if ($ch -eq 't') { 'true' } elseif ($ch -eq 'f') { 'false' } else { 'null' }
      if ($i + $literal.Length -le $Text.Length -and
          [string]::Equals($Text.Substring($i, $literal.Length), $literal, [System.StringComparison]::Ordinal)) {
        $i += $literal.Length - 1
        continue
      }
      $strict = $false
      continue
    }
    # What remains that JSON allows outside a string: structure, and the
    # characters a number is spelled with. Anything else — a stray form feed, a
    # single quote opening a string, any other letter — is a document jq
    # refuses, and refusing it here is what keeps the two halves from
    # disagreeing about one file.
    if ('{}[]:'.IndexOf($ch) -lt 0 -and '0123456789+-.eE'.IndexOf($ch) -lt 0) { $strict = $false }
  }
  if (-not $strict) { return 'invalid' }
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
  # `-NoEnumerate` on 6+, where it exists: without it PowerShell 7 flattens a
  # one-element nested array during the decode, so `[[{…}]]` arrives as `[{…}]`
  # and an element-type check passes where 5.1 and jq both refuse the document.
  $parsed = if ($PSVersionTable.PSVersion.Major -ge 6) {
    ConvertFrom-Json -InputObject $Text -NoEnumerate
  } else {
    ConvertFrom-Json -InputObject $Text
  }
  if ($parsed -isnot [System.Array]) { $parsed = @($parsed) }
  # Comma-wrapped so the array survives the return with its element structure
  # intact. That wraps it in a PSObject, and 5.1's ConvertTo-Json writes a
  # wrapped collection as `{"value":[…],"Count":n}` rather than as an array —
  # so every caller casts to `[object[]]`, which sheds the wrapper without
  # touching the elements. `@()` sheds it too, but on pwsh 7 it also flattens a
  # nested element, which is the shape this reader exists to preserve.
  #
  # Measured on 5.1.26100.8875 and pwsh 7.7, cast and serialized: a two-object
  # array, a one-object array, `[]`, `[null]`, `[[{…}]]` and `[[],{…}]` all
  # produce the same JSON on both.
  return ,$parsed
}
