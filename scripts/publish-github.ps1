param(
  [string]$Repository
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot

function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable did not finish successfully. Publishing stopped." }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI is required. Install GitHub CLI from cli.github.com, then sign in with gh auth login.'
}
Invoke-Checked 'gh' @('auth', 'status', '--hostname', 'github.com')
$identityJson = & gh api user
if ($LASTEXITCODE -ne 0) { throw 'Your GitHub account could not be read.' }
$identity = $identityJson | ConvertFrom-Json
if (-not $Repository) { $Repository = "$($identity.login)/local-live-studio" }
if ($Repository -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*/[a-zA-Z0-9][a-zA-Z0-9_.-]*$') {
  throw 'Repository must have the form OWNER/REPOSITORY.'
}

$manifest = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$tag = "v$($manifest.version)"
$assetDirectory = Join-Path $projectRoot "dist/$tag"
$releaseManifest = Get-Content -LiteralPath (Join-Path $assetDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
if ($releaseManifest.version -ne $manifest.version) { throw 'Release version does not match package.json.' }
foreach ($line in (Get-Content -LiteralPath (Join-Path $assetDirectory 'SHA256SUMS.txt'))) {
  if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9.-]+\.zip)$') { throw 'The release checksum file is invalid.' }
  $expectedHash = $Matches[1]
  $assetName = $Matches[2]
  $actualHash = (Get-FileHash -LiteralPath (Join-Path $assetDirectory $assetName) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Checksum failed for $assetName." }
}
foreach ($file in $releaseManifest.sourceFiles) {
  $expectedHash = $releaseManifest.sourceHashes.$file
  $actualHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $expectedHash -or $actualHash -ne $expectedHash) { throw "Source changed since packaging: $file. Prepare a new release first." }
}
Invoke-Checked 'npm' @('test')

if (-not (Test-Path -LiteralPath '.git')) {
  Invoke-Checked 'git' @('init', '-b', 'main')
}
$gitRoot = (& git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [System.IO.Path]::GetFullPath($gitRoot) -ne $projectRoot) { throw 'The Git repository must be this application folder.' }
Invoke-Checked 'git' @('config', 'user.name', $identity.login)
Invoke-Checked 'git' @('config', 'user.email', "$($identity.id)+$($identity.login)@users.noreply.github.com")
Invoke-Checked 'git' (@('add', '--') + @($releaseManifest.sourceFiles))
$staged = @(& git diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect staged source files.' }
foreach ($file in $staged) {
  if ($file -notin $releaseManifest.sourceFiles) { throw "An unexpected file is staged: $file. It was not published." }
}
if ($staged.Count -gt 0) { Invoke-Checked 'git' @('commit', '-m', "Release Local LIVE Studio $($manifest.version)") }
$branch = (& git branch --show-current).Trim()
if ($branch -ne 'main') { throw 'Switch to the intended main branch before publishing.' }

$remoteJson = & gh repo view $Repository --json nameWithOwner 2>$null
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked 'gh' @('repo', 'create', $Repository, '--public', '--description', 'Independent Windows recording studio with online overlays and local guest gifts')
}
$remoteUrl = "https://github.com/$Repository.git"
$existingRemote = & git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
  if ($existingRemote.Trim().TrimEnd('/') -ne $remoteUrl) { throw 'Origin points to another repository. No remote was changed.' }
} else {
  Invoke-Checked 'git' @('remote', 'add', 'origin', $remoteUrl)
}
Invoke-Checked 'gh' @('auth', 'setup-git', '--hostname', 'github.com')
Invoke-Checked 'git' @('push', '-u', 'origin', 'main')
$revision = (& git rev-parse HEAD).Trim()
$existingRelease = & gh release view $tag --repo $Repository --json isDraft,tagName 2>$null
if ($LASTEXITCODE -eq 0) { throw 'A release with this version already exists. It was preserved; use a new version to publish an update.' }
$assets = @($releaseManifest.assets | ForEach-Object { Join-Path $assetDirectory $_ })
Invoke-Checked 'gh' (@('release', 'create', $tag, '--repo', $Repository, '--target', $revision, '--draft', '--title', "Local LIVE Studio $($manifest.version)", '--notes-file', (Join-Path $assetDirectory 'RELEASE-NOTES.md')) + $assets)
Invoke-Checked 'gh' @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest')
Invoke-Checked 'gh' @('release', 'view', $tag, '--repo', $Repository, '--json', 'url,assets')
Write-Output "Download page: https://github.com/$Repository/releases/tag/$tag"
