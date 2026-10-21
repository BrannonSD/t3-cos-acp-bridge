param(
  [string]$Destination = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'packages')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
& node (Join-Path $PSScriptRoot 'audit-publication.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Public source audit failed; archive was not created.' }
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid package version.' }
if (& git -C $root status --porcelain) { throw 'Commit source changes before creating a distributable archive.' }
$revision = (& git -C $root rev-parse --short=12 HEAD)
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{12}$') { throw 'Package requires a committed source revision.' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$stage = Join-Path $Destination ('.source-staging-' + [guid]::NewGuid().ToString('N'))
$out = Join-Path $Destination ('cos-acp-source-' + $version + '-' + $revision + '.zip')
if (Test-Path -LiteralPath $out) { throw 'Package already exists; do not overwrite a published source artifact.' }
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $inside = Join-Path $stage 'cos-acp'
  New-Item -ItemType Directory -Path $inside | Out-Null
  foreach ($file in @('README.md','SECURITY.md','Install.cmd','package.json','package-lock.json','tsconfig.json','.gitignore','.node-version')) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $inside $file) -ErrorAction Stop
  }
  foreach ($dir in @('src','test','scripts','.github','docs','assets')) {
    Copy-Item -LiteralPath (Join-Path $root $dir) -Destination $inside -Recurse -ErrorAction Stop
  }
  Compress-Archive -LiteralPath $inside -DestinationPath $out -CompressionLevel Optimal -ErrorAction Stop
  Write-Output ('Portable source package: ' + $out)
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}