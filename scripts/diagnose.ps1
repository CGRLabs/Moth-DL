[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction Stop
$cliCandidates = @(
  (Join-Path $PSScriptRoot 'moth.mjs'),
  (Join-Path $PSScriptRoot '..\cli\moth.mjs')
)
$cli = $cliCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

Write-Host 'Moth read-only diagnostics'
Write-Host '=========================='
Write-Host ("PowerShell: {0}" -f $PSVersionTable.PSVersion)
Write-Host ("Node.js:    {0}" -f (& $node.Source --version))

$dataDirectory = if ($env:APPDATA) { Join-Path $env:APPDATA 'moth-dlm' } else { $null }
if (-not $dataDirectory) {
  Write-Warning 'APPDATA is not set; could not locate the default Moth data directory.'
} elseif (Test-Path -LiteralPath $dataDirectory -PathType Container) {
  Write-Host ("Data folder: {0}" -f $dataDirectory)
  foreach ($relativePath in @('moth.db', 'logs', 'bin', 'extension')) {
    $target = Join-Path $dataDirectory $relativePath
    if (Test-Path -LiteralPath $target) {
      $item = Get-Item -LiteralPath $target
      Write-Host ("  OK  {0} ({1})" -f $relativePath, $item.LastWriteTime)
    } else {
      Write-Host ("  --  {0} not present" -f $relativePath)
    }
  }
} else {
  Write-Warning ("Default Moth data folder not found: {0}" -f $dataDirectory)
}

$mothProcesses = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'moth' } |
  Select-Object -Property ProcessName, Id
if ($mothProcesses) {
  Write-Host 'Moth-related processes:'
  $mothProcesses | Format-Table -AutoSize | Out-Host
} else {
  Write-Host 'No process with "moth" in its name was found.'
}

if ($env:MOTH_API_TOKEN -and $cli) {
  Write-Host 'Live engine check:'
  & $node.Source $cli doctor
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} elseif (-not $env:MOTH_API_TOKEN) {
  Write-Host 'Live engine check skipped. Set MOTH_API_TOKEN from Moth Settings to include it.'
} else {
  Write-Warning 'The moth.mjs CLI was not found beside this diagnostic script.'
}

Write-Host 'Diagnostics are read-only. No administrator access or Windows setting changes were used.'
