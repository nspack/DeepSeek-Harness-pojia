# Upgrade the selected DeepSeek Harness profile to a pinned wxcvm fork release.
# Does not apply host patches, delete targets, or restart the application.
param(
  [string]$DshHome = '',
  [ValidateSet('desktop','web')][string]$Profile = 'desktop',
  # 默认取本仓库 package.json 的版本，避免每次发版都要改脚本（-Version 可显式覆盖）
  [string]$Version = '',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'package.json'
if (-not $Version) {
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Cannot determine release version: $manifestPath not found. Pass -Version explicitly."
  }
  $Version = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
}
$version = $Version
$source = "https://codeload.github.com/wxcvm/dsh-purge/tar.gz/refs/tags/v$version"

if (-not $DshHome) {
  $candidates = @()
  if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.dsh') }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'DeepSeek Harness\dsh-home') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home') }
  $homes = @($candidates | Select-Object -Unique | Where-Object {
    Test-Path -LiteralPath (Join-Path $_ "profiles\$Profile\package.json") -PathType Leaf
  })
  if ($homes.Count -ne 1) {
    $homes | ForEach-Object { Write-Host "Possible DSH_HOME: $_" }
    throw 'Specify -DshHome explicitly: no unique active profile was found.'
  }
  $DshHome = $homes[0]
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Profile manifest not found: $manifest" }
$plugin = Join-Path $profileDir 'node_modules\dsh-purge'
$pluginManifest = Join-Path $plugin 'package.json'
$oldVersion = '(not installed)'
if (Test-Path -LiteralPath $pluginManifest -PathType Leaf) {
  $oldVersion = (Get-Content -LiteralPath $pluginManifest -Raw | ConvertFrom-Json).version
}
Write-Host "DSH profile: $profileDir"
Write-Host "Installed dsh-purge: $oldVersion"
if ($CheckOnly) {
  if ($oldVersion -ne $version) { throw "Expected $version in this profile; found $oldVersion" }
  foreach ($file in @('client.js','lib\redteam\ui.js','lib\redteam\client.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $plugin $file) -PathType Leaf)) {
      throw "Installed package is incomplete: $file"
    }
  }
  # The package can exist without its Cordis profile entry (postinstall may have been skipped).
  # This is read-only: do not silently modify the user's profile during -CheckOnly.
  $profilePackage = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  if (@($profilePackage.dsh.profile.bundles) -notcontains 'dsh-purge') {
    throw 'Plugin files exist, but dsh.profile.bundles lacks dsh-purge. In the profile directory run: node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs'
  }
  $patchFile = Join-Path $profileDir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $patchFile -PathType Leaf)) {
    throw "Plugin files exist, but the profile insert file is missing: $patchFile. Run node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs"
  }
  $patchText = Get-Content -LiteralPath $patchFile -Raw
  if ($patchText -notmatch '(?m)^\s*-\s*insert:\s*$' -or
      $patchText -notmatch '(?m)^\s*-\s*(?:id:\s*dsh-purge(?:-main)?|name:\s*dsh-purge)\s*$') {
    throw "Plugin files exist, but the dsh-purge insert is missing from $patchFile. Run node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs"
  }
  Write-Host "PASS: dsh-purge $version files, profile bundle and Cordis insert are present."
  Write-Host "Note: a running DSH host must still be restarted to load the plugin."
  return
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm was not found. Install pnpm or use dsh plugin add with the pinned tag URL.'
}

# Preserve files that pnpm and postinstall may change in this profile.
$backup = Join-Path ([IO.Path]::GetTempPath()) ('dsh-purge-profile-backup-' + [guid]::NewGuid().ToString('N'))
New-Item -Path $backup -ItemType Directory -Force | Out-Null
$files = @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')
$had = @{}
foreach ($file in $files) {
  $original = Join-Path $profileDir $file
  $had[$file] = Test-Path -LiteralPath $original -PathType Leaf
  if ($had[$file]) { Copy-Item -LiteralPath $original -Destination (Join-Path $backup $file) -Force }
}
# Snapshot the resolved plugin contents as well as profile metadata.
# pnpm normally exposes the package through a junction/symlink into its virtual store;
# restoring only package.json and the lockfile cannot recover a partially changed plugin.
$pluginPresent = Test-Path -LiteralPath $plugin -PathType Container
$pluginBackup = Join-Path $backup 'plugin-files'
$originalHashes = @{}
if ($pluginPresent) {
  New-Item -Path $pluginBackup -ItemType Directory | Out-Null
  Get-ChildItem -LiteralPath $plugin -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $pluginBackup -Recurse -Force
  }
  foreach ($file in (Get-ChildItem -LiteralPath $pluginBackup -Recurse -File -Force)) {
    $relative = $file.FullName.Substring($pluginBackup.Length + 1)
    $originalHashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  }
}
$success = $false
Push-Location $profileDir
try {
  Write-Host "Installing $version from $source"
  & pnpm add $source
  if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $pluginManifest -PathType Leaf)) { throw 'Installed package manifest is missing' }
  $actual = (Get-Content -LiteralPath $pluginManifest -Raw | ConvertFrom-Json).version
  if ($actual -ne $version) { throw "Installed version $actual does not match $version" }
  foreach ($file in @('client.js','lib\redteam\ui.js','lib\redteam\client.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $plugin $file) -PathType Leaf)) {
      throw "Installed package is missing required UI file: $file"
    }
  }
  $success = $true
  Write-Host "PASS: installed dsh-purge $version in $profileDir"
} catch {
  $problem = $_.Exception.Message
  $rollbackIssues = @()
  foreach ($file in $files) {
    $original = Join-Path $profileDir $file
    try {
      if ($had[$file]) {
        Copy-Item -LiteralPath (Join-Path $backup $file) -Destination $original -Force
      } elseif (Test-Path -LiteralPath $original) {
        Remove-Item -LiteralPath $original -Force
      }
    } catch { $rollbackIssues += "Could not restore ${file}: $($_.Exception.Message)" }
  }

  # Rebuild the original package-manager layout first, when the old lockfile exists.
  if ($had['pnpm-lock.yaml']) {
    try {
      & pnpm install --frozen-lockfile --ignore-scripts
      if ($LASTEXITCODE -ne 0) { $rollbackIssues += "pnpm dependency reinstall exited $LASTEXITCODE" }
    } catch { $rollbackIssues += "pnpm dependency reinstall failed: $($_.Exception.Message)" }
  }

  # Verify the COMPLETE previous plugin contents, not just its declared version.
  $pluginMatches = $pluginPresent -and (Test-Path -LiteralPath $plugin -PathType Container)
  if ($pluginMatches) {
    try {
      $currentFiles = @(Get-ChildItem -LiteralPath $plugin -Recurse -File -Force)
      if ($currentFiles.Count -ne $originalHashes.Count) { $pluginMatches = $false }
      foreach ($entry in $originalHashes.GetEnumerator()) {
        $installed = Join-Path $plugin $entry.Key
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or
          (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $entry.Value) {
          $pluginMatches = $false
          break
        }
      }
    } catch { $pluginMatches = $false }
  }
  if (-not $pluginMatches) {
    try {
      # Only remove the selected plugin path; remove reparse points as links,
      # never recursively follow a pnpm junction into other dependencies.
      if (Test-Path -LiteralPath $plugin) {
        $existing = Get-Item -LiteralPath $plugin -Force
        if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          Remove-Item -LiteralPath $plugin -Force
        } else {
          Remove-Item -LiteralPath $plugin -Recurse -Force
        }
      }
      if ($pluginPresent) {
        Copy-Item -LiteralPath $pluginBackup -Destination $plugin -Recurse -Force
      }
      $pluginMatches = -not $pluginPresent -or (Test-Path -LiteralPath $plugin -PathType Container)
      if ($pluginMatches -and $pluginPresent) {
        foreach ($entry in $originalHashes.GetEnumerator()) {
          $installed = Join-Path $plugin $entry.Key
          if (-not (Test-Path -LiteralPath $installed -PathType Leaf) -or
            (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $entry.Value) {
            $pluginMatches = $false
            break
          }
        }
      }
    } catch {
      $pluginMatches = $false
      $rollbackIssues += "Could not restore previous plugin snapshot: $($_.Exception.Message)"
    }
  }
  if (-not $pluginMatches) { $rollbackIssues += 'Previous plugin files were not fully restored' }
  $status = if ($rollbackIssues.Count -eq 0) { 'previous profile and plugin files restored' }
            else { 'incomplete: ' + ($rollbackIssues -join '; ') }
  throw "Upgrade failed: $problem. Rollback: $status. Backup retained at: $backup"
} finally {
  Pop-Location
  if ($success) { Remove-Item -LiteralPath $backup -Recurse -Force }
}
Write-Host 'Fully quit DSH Desktop, including its tray process, and reopen it.'
Write-Host 'Then inspect 作战台 > 管理 > 指南 > 检查实际安装副本 / 技能库 / 已归档靶标.'
