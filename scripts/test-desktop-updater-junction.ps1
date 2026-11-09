$ErrorActionPreference = 'Stop'
$updater = Join-Path $PSScriptRoot 'update-desktop-fork.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('dsh-junction-test-' + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $fixture 'profiles\desktop'
$plugin = Join-Path $profile 'node_modules\dsh-purge'
$store = Join-Path $fixture 'pnpm-virtual-store\dsh-purge'
$bin = Join-Path $fixture 'bin'
$oldPath = $env:PATH
try {
  New-Item -ItemType Directory -Path (Join-Path $store 'lib\redteam') -Force | Out-Null
  New-Item -ItemType Directory -Path (Split-Path $plugin -Parent) -Force | Out-Null
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  New-Item -ItemType Junction -Path $plugin -Target $store | Out-Null
  if (-not ((Get-Item -LiteralPath $plugin -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Test fixture did not create a real junction'
  }

  $version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
  $manifest = '{"name":"dsh-profile-desktop","dependencies":{"dsh-purge":"pinned-old-source"}}'
  $originalPluginManifest = '{"version":"' + $version + '"}'
  Set-Content -LiteralPath (Join-Path $profile 'package.json') -Value $manifest -NoNewline
  Set-Content -LiteralPath (Join-Path $profile 'pnpm-lock.yaml') -Value 'original-junction-lock' -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'package.json') -Value $originalPluginManifest -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'client.js') -Value 'old junction client' -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'lib\redteam\ui.js') -Value 'old junction UI' -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'lib\redteam\client.js') -Value 'old drill client' -NoNewline
  Set-Content -LiteralPath (Join-Path $store 'sentinel.txt') -Value 'virtual store survives' -NoNewline

  & $updater -DshHome $fixture -CheckOnly
  if (-not $?) { throw 'Read-only profile check failed' }

  $mock = @'
@echo off
if /I "%~1"=="add" (
  echo damaged>"%DSH_TEST_PLUGIN%\client.js"
  del /q "%DSH_TEST_PLUGIN%\lib\redteam\ui.js"
  echo corrupted>"%DSH_TEST_PLUGIN%\package.json"
  echo changed>"%DSH_TEST_PROFILE%\package.json"
  echo new content>"%DSH_TEST_PLUGIN%\new-file.txt"
  exit /b 9
)
exit /b 7
'@
  Set-Content -LiteralPath (Join-Path $bin 'pnpm.cmd') -Value $mock -Encoding Ascii
  $env:DSH_TEST_PLUGIN = $plugin
  $env:DSH_TEST_PROFILE = $profile
  $env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH

  $failure = $null
  try { & $updater -DshHome $fixture } catch { $failure = $_ }
  if ($null -eq $failure) { throw 'Expected failed package upgrade' }
  if ((Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw) -ne $manifest) {
    throw 'Profile manifest was not restored'
  }
  if ((Get-Content -LiteralPath (Join-Path $profile 'pnpm-lock.yaml') -Raw) -ne 'original-junction-lock') {
    throw 'Profile lockfile was not restored'
  }
  foreach ($entry in @(
    @('package.json', $originalPluginManifest),
    @('client.js', 'old junction client'),
    @('lib\redteam\ui.js', 'old junction UI'),
    @('lib\redteam\client.js', 'old drill client'),
    @('sentinel.txt', 'virtual store survives')
  )) {
    $file = Join-Path $plugin $entry[0]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
        (Get-Content -LiteralPath $file -Raw) -ne $entry[1]) {
      throw "Recovered plugin contents differ: $($entry[0])"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $plugin 'new-file.txt')) {
    throw 'Injected new file was not removed during rollback'
  }
  if ((Get-Content -LiteralPath (Join-Path $store 'sentinel.txt') -Raw) -ne 'virtual store survives') {
    throw 'Removing a junction deleted its underlying virtual-store contents'
  }
  if (-not (Test-Path -LiteralPath $store -PathType Container)) {
    throw 'Original pnpm virtual-store directory was deleted'
  }

  Write-Host 'PASS: failed upgrade via real Windows junction restores selected profile without deleting virtual store'
  $global:LASTEXITCODE = 0
} finally {
  $env:PATH = $oldPath
  Remove-Item Env:DSH_TEST_PLUGIN -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_TEST_PROFILE -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $plugin) {
    $current = Get-Item -LiteralPath $plugin -Force
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Remove-Item -LiteralPath $plugin -Force
    }
  }
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
