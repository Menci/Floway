# JsonReaderWriterFactory is available on the .NET Framework behind Windows
# PowerShell 5.1 and on modern .NET behind PowerShell 7. Its XML infoset keeps
# arbitrary JSON depth and case-distinct property names without ConvertTo-Json's
# depth-100 ceiling or PSCustomObject's case-insensitive property lookup.
# https://learn.microsoft.com/dotnet/framework/wcf/feature-details/mapping-between-json-and-xml
Add-Type -AssemblyName System.Runtime.Serialization

function Assert-SetupJsonHasNoTrailingComma {
  param([string]$Json)
  $insideString = $false
  $escaped = $false
  $lastSignificant = [char]0
  for ($index = 0; $index -lt $Json.Length; $index++) {
    $character = $Json[$index]
    if ($insideString) {
      if ($escaped) { $escaped = $false }
      elseif ($character -ceq '\') { $escaped = $true }
      elseif ($character -ceq '"') { $insideString = $false }
      continue
    }
    if ($character -ceq '"') {
      $insideString = $true
      $lastSignificant = $character
      continue
    }
    if (($character -ceq '}' -or $character -ceq ']') -and $lastSignificant -ceq ',') {
      throw 'JSON contains a trailing comma.'
    }
    if (-not [char]::IsWhiteSpace($character)) { $lastSignificant = $character }
  }
}

function Get-SetupJsonElementName {
  param([System.Xml.XmlElement]$Element)
  if (($Element.LocalName -ceq 'item') -and ($Element.NamespaceURI -ceq 'item')) {
    return $Element.GetAttribute('item')
  }
  return $Element.LocalName
}

function Assert-SetupJsonInfoset {
  param([System.Xml.XmlDocument]$Document)
  $numberPattern = '\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z'
  $pending = [System.Collections.Generic.Stack[System.Xml.XmlElement]]::new()
  $pending.Push($Document.DocumentElement)
  while ($pending.Count -gt 0) {
    $element = $pending.Pop()
    $type = $element.GetAttribute('type')
    if (($type -ceq 'number') -and (-not [regex]::IsMatch(
      $element.InnerText,
      $numberPattern,
      [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    ))) {
      throw "JSON contains an invalid number: $($element.InnerText)"
    }
    $names = $null
    if ($type -ceq 'object') {
      $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    }
    foreach ($child in $element.ChildNodes) {
      if ($child -isnot [System.Xml.XmlElement]) { continue }
      if (($null -ne $names) -and (-not $names.Add((Get-SetupJsonElementName $child)))) {
        throw "JSON contains a duplicate property: $(Get-SetupJsonElementName $child)"
      }
      $pending.Push($child)
    }
  }
}

function Read-SetupJsonDocument {
  param([string]$Json)
  Assert-SetupJsonHasNoTrailingComma $Json
  # WCF reserves a literal first `__type` member as metadata. The escaped token
  # is JSON-equivalent and forces ordinary property handling for every value type.
  $jsonForReader = $Json.Replace('"__type"', '"\u005f_type"')
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonForReader)
  $maxBytes = if ($env:AGENT_SETUP_TEST_JSON_MAX_BYTES) { [int]$env:AGENT_SETUP_TEST_JSON_MAX_BYTES } else { 8388608 }
  if ($bytes.Length -gt $maxBytes) { throw 'JSON exceeds the 8 MiB size limit.' }
  $bound = [Math]::Max(16384, $bytes.Length)
  $quotas = New-Object System.Xml.XmlDictionaryReaderQuotas
  $quotas.MaxDepth = $bound
  $quotas.MaxStringContentLength = $bound
  $quotas.MaxArrayLength = $bound
  $quotas.MaxNameTableCharCount = $bound
  $reader = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonReader($bytes, $quotas)
  try {
    $document = New-Object System.Xml.XmlDocument
    $document.PreserveWhitespace = $false
    $document.Load($reader)
  } finally {
    $reader.Close()
  }
  Assert-SetupJsonInfoset $document
  return $document
}

function Write-SetupJsonDocument {
  param([System.Xml.XmlDocument]$Document)
  $stream = New-Object System.IO.MemoryStream
  $writer = $null
  $reader = $null
  try {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $writer = [System.Runtime.Serialization.Json.JsonReaderWriterFactory]::CreateJsonWriter($stream, $encoding, $false, $true, '  ')
    $reader = New-Object System.Xml.XmlNodeReader($Document)
    $writer.WriteNode($reader, $false)
    $writer.Flush()
    return [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
  } finally {
    if ($null -ne $reader) { $reader.Close() }
    if ($null -ne $writer) { $writer.Close() }
    $stream.Dispose()
  }
}

function Get-SetupJsonProperty {
  param([System.Xml.XmlElement]$Target, [string]$Name)
  foreach ($child in $Target.ChildNodes) {
    if (($child -is [System.Xml.XmlElement]) -and [string]::Equals(
      (Get-SetupJsonElementName $child),
      $Name,
      [System.StringComparison]::Ordinal
    )) {
      return $child
    }
  }
  return $null
}

function New-SetupJsonProperty {
  param([System.Xml.XmlElement]$Target, [string]$Name, [string]$Type)
  $element = $Target.OwnerDocument.CreateElement('a', 'item', 'item')
  $null = $element.SetAttribute('item', $Name)
  $null = $element.SetAttribute('type', $Type)
  $null = $Target.AppendChild($element)
  return $element
}

function Get-SetupJsonObjectProperty {
  param([System.Xml.XmlElement]$Target, [string]$Name)
  $element = Get-SetupJsonProperty $Target $Name
  if ($null -eq $element) { return $null }
  if ($element.GetAttribute('type') -cne 'object') { throw "$Name is not a JSON object" }
  return $element
}

function Get-OrCreate-SetupJsonObjectProperty {
  param([System.Xml.XmlElement]$Target, [string]$Name)
  $element = Get-SetupJsonObjectProperty $Target $Name
  if ($null -eq $element) { $element = New-SetupJsonProperty $Target $Name 'object' }
  return $element
}

function Set-SetupProp {
  param([System.Xml.XmlElement]$Target, [string]$Name, $Value)
  $element = Get-SetupJsonProperty $Target $Name
  $type = if ($null -eq $Value) { 'null' }
    elseif ($Value -is [bool]) { 'boolean' }
    elseif ($Value -is [string]) { 'string' }
    elseif ($Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or
      $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64] -or
      $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) { 'number' }
    else { throw "unsupported JSON value type: $($Value.GetType().FullName)" }
  if ($null -eq $element) { $element = New-SetupJsonProperty $Target $Name $type }
  while ($element.HasChildNodes) { $null = $element.RemoveChild($element.FirstChild) }
  $null = $element.SetAttribute('type', $type)
  if ($type -ceq 'boolean') { $element.InnerText = if ($Value) { 'true' } else { 'false' } }
  elseif ($type -ceq 'number') { $element.InnerText = [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture) }
  elseif ($type -ceq 'string') { $element.InnerText = [string]$Value }
}

function Remove-SetupProp {
  param([System.Xml.XmlElement]$Target, [string]$Name)
  $element = Get-SetupJsonProperty $Target $Name
  if ($null -ne $element) { $null = $Target.RemoveChild($element) }
}

function Set-SetupOptionalProp {
  param([System.Xml.XmlElement]$Target, [string]$Name, $Value)
  if ($null -eq $Value) { Remove-SetupProp $Target $Name } else { Set-SetupProp $Target $Name $Value }
}

function Test-SetupJsonObjectEmpty {
  param([System.Xml.XmlElement]$Target)
  foreach ($child in $Target.ChildNodes) {
    if ($child -is [System.Xml.XmlElement]) { return $false }
  }
  return $true
}
