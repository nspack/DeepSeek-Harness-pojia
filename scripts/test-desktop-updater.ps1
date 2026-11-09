$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'update-desktop-fork.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('dsh-purge-updater-test-' + [guid]::NewGuid().ToString('N'))
$profile = Join-Path $fixture 'profiles\desktop'
$plugin = Join-Path $profile 'node_modules\dsh-purge'
$bin = Join-Path $fixture 'bin'
$oldPath = $env:PATH
try {
  New-Item -Path (Join-Path $plugin 'lib\redteam') -ItemType Directory -Force | Out-Null
  New-Item -Path $bin -ItemType Directory -Force | Out-Null
  $version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
  $manifest = '{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":["dsh-purge"]}},"dependencies":{"dsh-purge":"original-spec"}}'
  Set-Content -LiteralPath (Join-Path $profile 'package.json') -Value $manifest -NoNewline
  Set-Content -LiteralPath (Join-Path $profile 'cordis.patch.yml') -Value "- insert:`n    - id: dsh-purge" -NoNewline
  Set-Content -LiteralPath (Join-Path $profile 'pnpm-lock.yaml') -Value 'original-lock' -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'package.json') -Value ('{"version":"' + $version + '"}') -NoNewline
  foreach ($file in @('client.js','lib\redteam\ui.js','lib\redteam\client.js')) {
    Set-Content -LiteralPath (Join-Path $plugin $file) -Value 'fixture' -NoNewline
  }
  & $script -DshHome $fixture -CheckOnly
  if (-not $?) { throw 'CheckOnly did not succeed' }
  # Files alone must not be treated as proof that the plugin has a host entry.
  $patchPath = Join-Path $profile 'cordis.patch.yml'
  Set-Content -LiteralPath $patchPath -Value '- replace: []' -NoNewline
  $rejected = $false
  try { & $script -DshHome $fixture -CheckOnly } catch {
    $rejected = $_.Exception.Message -like '*insert*'
  }
  if (-not $rejected) { throw 'CheckOnly accepted a profile without the plugin insert' }
  Set-Content -LiteralPath $patchPath -Value "- insert:`n    - id: dsh-purge" -NoNewline
  Set-Content -LiteralPath (Join-Path $profile 'package.json') -Value '{"name":"dsh-profile-desktop","dependencies":{"dsh-purge":"original-spec"}}' -NoNewline
  $rejected = $false
  try { & $script -DshHome $fixture -CheckOnly } catch {
    $rejected = $_.Exception.Message -like '*bundles*'
  }
  if (-not $rejected) { throw 'CheckOnly accepted a profile without the plugin bundle' }
  Set-Content -LiteralPath (Join-Path $profile 'package.json') -Value $manifest -NoNewline
    # Simulate a package manager which first overwrites package files and the
  # profile manifest, then fails both upgrade and dependency reinstall.
  $oldClient = 'previous-client-content'
  $oldUI = 'previous-ui-content'
  Set-Content -LiteralPath (Join-Path $plugin 'client.js') -Value $oldClient -NoNewline
  Set-Content -LiteralPath (Join-Path $plugin 'lib\redteam\ui.js') -Value $oldUI -NoNewline
  $mock = @'
@echo off
if /I "%~1"=="add" (
  echo changed>"%DSH_TEST_PLUGIN%\client.js"
  echo corrupt>"%DSH_TEST_PLUGIN%\package.json"
  del /q "%DSH_TEST_PLUGIN%\lib\redteam\ui.js"
  echo mutated>"%DSH_TEST_PROFILE%\package.json"
  exit /b 9
)
exit /b 7
'@
  Set-Content -LiteralPath (Join-Path $bin 'pnpm.cmd') -Value $mock -Encoding Ascii
  $env:DSH_TEST_PLUGIN = $plugin
  $env:DSH_TEST_PROFILE = $profile
  $env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
  $failed = $false
  try { & $script -DshHome $fixture } catch { $failed = $true }
  if (-not $failed) { throw 'Expected simulated pnpm failure' }
  if ((Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw) -ne $manifest) {
    throw 'Profile manifest was not restored'
  }
  if ((Get-Content -LiteralPath (Join-Path $profile 'pnpm-lock.yaml') -Raw) -ne 'original-lock') {
    throw 'Original lockfile was not restored'
  }
  if ((Get-Content -LiteralPath (Join-Path $plugin 'client.js') -Raw) -ne $oldClient) {
    throw 'The full previous client.js was not restored'
  }
  if ((Get-Content -LiteralPath (Join-Path $plugin 'lib\redteam\ui.js') -Raw) -ne $oldUI) {
    throw 'Deleted plugin UI was not restored from the snapshot'
  }
  if ((Get-Content -LiteralPath (Join-Path $plugin 'package.json') -Raw) -ne ('{"version":"' + $version + '"}')) {
    throw 'Previous plugin manifest was not restored'
  }
  Write-Host 'PASS: read-only verification and failed-install full plugin/profile rollback'
  # Clear the expected non-zero native exit from our fake pnpm; otherwise the
  # GitHub pwsh wrapper treats a successful test as a failed job.
  $global:LASTEXITCODE = 0
} finally {
  $env:PATH = $oldPath
  Remove-Item Env:DSH_TEST_PLUGIN -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_TEST_PROFILE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
