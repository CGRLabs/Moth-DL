<#
.SYNOPSIS
  Creates (or refreshes) a Desktop shortcut for Moth Download Manager.

.DESCRIPTION
  Points at the packaged executable in release\autopair-build\win-unpacked, which is the
  fastest way to launch the app without running the installer. Run again after
  a rebuild and the shortcut keeps pointing at the current binary.

  If the packaged build is missing, falls back to launching the development
  build via `npm start`, so the shortcut always works.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\shortcut.ps1
#>

[CmdletBinding()]
param(
  [string]$Name = 'Moth Download Manager'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPaths = @(
  (Join-Path $desktop "$Name.lnk"),
  (Join-Path $startMenu "$Name.lnk")
)
$iconPath = Join-Path $root 'resources\moth.ico'

$packaged = Join-Path $root 'release\autopair-build\win-unpacked\Moth Download Manager.exe'
$hasPackaged = Test-Path -LiteralPath $packaged

if ($hasPackaged) {
  $target = $packaged
  $workingDir = Split-Path -Parent $packaged
  $arguments = '--no-sandbox'
} else {
  # No packaged build yet: launch the dev build. cmd /c keeps the console
  # window from flashing shut the moment Electron detaches.
  $target = 'cmd.exe'
  $workingDir = $root
  $arguments = '/c npm start'
}

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $target
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $workingDir
  $shortcut.Description = 'Moth Download Manager - resumable multi-threaded download manager'
  $shortcut.WindowStyle = 7

  if (Test-Path -LiteralPath $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
  }

  $shortcut.Save()
  Write-Host "Shortcut created: $shortcutPath"
}
Write-Host "  Target: $target $arguments"
if ($hasPackaged) {
  Write-Host '  Points at the packaged build.'
} else {
  Write-Host '  No packaged build found, pointing at the dev build (npm start).'
  Write-Host '  Run `npm run dist` for a standalone executable.'
}
