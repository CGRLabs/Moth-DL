[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter()]
  [ValidatePattern('^[a-fA-F0-9-]{8,64}$')]
  [string]$Id
)

$ErrorActionPreference = 'Stop'
if (-not $env:MOTH_API_TOKEN) {
  throw 'Set MOTH_API_TOKEN from Moth Settings before running a repair.'
}

$node = Get-Command node -ErrorAction Stop
$cliCandidates = @(
  (Join-Path $PSScriptRoot 'moth.mjs'),
  (Join-Path $PSScriptRoot '..\cli\moth.mjs')
)
$cli = $cliCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $cli) {
  throw 'Could not find the Moth CLI beside this repair script.'
}

$target = if ($Id) { "download $Id" } else { 'all Moth download records' }
if ($PSCmdlet.ShouldProcess($target, 'Reconcile download records with on-disk files')) {
  $arguments = @($cli, 'repair')
  if ($Id) {
    $arguments += @('--id', $Id)
  }
  & $node.Source @arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
