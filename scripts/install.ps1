param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'T3-CoS-Integration'),
  [string]$NodePath,
  [ValidateSet('modern','existing-install')][string]$Mode = 'modern',
  [switch]$AutoStartMain,
  [switch]$RegisterT3
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
  # Prefer the public Node.js installation on PATH for reproducible installs.
  # Existing runtime metadata is only a fallback for machines without PATH Node.
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $NodePath = $found.Source }
  if (-not $NodePath) {
    $existing = Join-Path $InstallRoot 'installation.json'
    if (Test-Path -LiteralPath $existing) {
      try {
        $candidate = (Get-Content -LiteralPath $existing -Raw | ConvertFrom-Json).node
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $NodePath = $candidate }
      } catch {}
    }
  }
}
if (-not $NodePath) { throw 'Node.js 24 or later is required. Install Node.js or pass -NodePath.' }
$resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersion = & $resolvedNode -p 'process.versions.node'
if ([version]$nodeVersion -lt [version]'24.0.0') { throw 'The integration requires Node.js 24 or later.' }
$npmCli = Join-Path (Split-Path $resolvedNode) 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCommand) { $npmCli = Join-Path (Split-Path $npmCommand.Source) 'node_modules/npm/bin/npm-cli.js' }
}
if (-not (Test-Path -LiteralPath $npmCli)) { throw 'npm is required. Install npm alongside Node.js.' }
Push-Location $sourceRoot
try {
  $hasGit = Test-Path -LiteralPath (Join-Path $sourceRoot '.git')
  if ($hasGit -and (& git status --porcelain)) { throw 'Commit or preserve source changes before preparing an immutable release.' }
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules/typescript/bin/tsc'))) {
    & $resolvedNode $npmCli ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Development dependencies could not be installed.' }
  }
  & $resolvedNode (Join-Path $sourceRoot 'node_modules/typescript/bin/tsc')
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  # T3 can invoke the installer from an auto-started adapter process. Mock
  # integration tests must never inherit that process's CoS auto-start setting.
  $previousAutoStart = [Environment]::GetEnvironmentVariable('COS_ACP_AUTOSTART', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('COS_ACP_AUTOSTART', $null, 'Process')
    & $resolvedNode --import tsx --test 'test/*.test.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
  } finally {
    [Environment]::SetEnvironmentVariable('COS_ACP_AUTOSTART', $previousAutoStart, 'Process')
  }
  if ($hasGit) {
    $revision = (& git rev-parse --short=12 HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{12}$') { throw 'A committed source revision is required.' }
  } else {
    # Downloaded source archives have no Git metadata. Produce a stable local
    # revision from the archive contents, without hashing build output/deps.
    $files = @((Join-Path $sourceRoot 'package.json'),(Join-Path $sourceRoot 'package-lock.json'),(Join-Path $sourceRoot 'tsconfig.json'))
    foreach ($dir in @('src','test','scripts')) {
      $files += @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot $dir) -File -Recurse | Select-Object -ExpandProperty FullName)
    }
    $manifestLines = foreach($entry in ($files | Sort-Object)) {
      $relative = $entry.Substring($sourceRoot.Length).Replace('\','/')
      $checksum = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
      $relative + ':' + $checksum
    }
    $payload = [Text.Encoding]::UTF8.GetBytes(($manifestLines -join [Environment]::NewLine))
    $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($payload)
    $revision = ([BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()).Substring(0,12)
  }
  $package = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'package.json') | ConvertFrom-Json
  $releaseName = "$($package.version)-$revision"
  $release = Join-Path (Join-Path $InstallRoot 'releases') $releaseName
  $releasesRoot = Join-Path $InstallRoot 'releases'
  New-Item -ItemType Directory -Force -Path $releasesRoot | Out-Null
  if (Test-Path -LiteralPath $release) {
    & $resolvedNode (Join-Path $PSScriptRoot 'release-tools.mjs') verify $release $resolvedNode
    if ($LASTEXITCODE -ne 0) { throw 'The existing immutable release did not verify. It was not overwritten.' }
  } else {
  $stage = Join-Path $releasesRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'dist') -Destination $stage -Recurse
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json'),(Join-Path $sourceRoot 'package-lock.json') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-tools.mjs') -Destination $stage

  Push-Location $stage
  try {
    & $resolvedNode $npmCli ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
  } finally { Pop-Location }
  & $resolvedNode (Join-Path $PSScriptRoot 'release-tools.mjs') create $stage $resolvedNode $revision
  if ($LASTEXITCODE -ne 0) { throw 'Release manifest creation failed; staged files retained for diagnosis.' }
  & $resolvedNode (Join-Path $PSScriptRoot 'release-tools.mjs') verify $stage $resolvedNode
  if ($LASTEXITCODE -ne 0) { throw 'Staged release did not verify.' }
  # Both paths are children of the explicit releases directory; never move an arbitrary tree.
  $resolvedReleaseRoot = [IO.Path]::GetFullPath($releasesRoot).TrimEnd('\') + '\'
  if (-not [IO.Path]::GetFullPath($stage).StartsWith($resolvedReleaseRoot,[StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFullPath($release).StartsWith($resolvedReleaseRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escaped install root.' }
  Move-Item -LiteralPath $stage -Destination $release
  }
  $state = Join-Path $InstallRoot 'state'
  New-Item -ItemType Directory -Force -Path $state | Out-Null
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $state /inheritance:r /grant:r "${principal}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect integration state.' }
  }
  $database = Join-Path $state 'state.sqlite'
  if (Test-Path -LiteralPath $database) {
    & $resolvedNode (Join-Path $PSScriptRoot 'release-tools.mjs') preflight $release $resolvedNode $database
    if ($LASTEXITCODE -ne 0) { throw 'Existing adapter state cannot safely switch releases. Registration was not changed.' }
  }
  $record = @{ driver = 'acpRegistry'; displayName = 'Chat on Steroids'; enabled = $true; accentColor = '#65a30d'; environment = @(@{name='COS_ACP_MODE';sensitive=$false;value=$Mode},@{name='COS_ACP_HOME';sensitive=$false;value=$state}); config = @{ source = 'local'; commandPath = $resolvedNode; commandArgs = @('--disable-warning=ExperimentalWarning',(Join-Path $release 'dist/cli.js')); integration = 'chat-on-steroids'; customModels = @() } }
  $registrationPath = Join-Path $InstallRoot 'provider-registration.json'
  if ($AutoStartMain) {
    if ($Mode -ne 'existing-install') { throw 'Automatic main-app startup requires existing-install mode.' }
    $record.environment += @{name='COS_ACP_AUTOSTART';value='1';sensitive=$false}
  }
  if (Test-Path -LiteralPath $registrationPath) { Copy-Item -LiteralPath $registrationPath -Destination "$registrationPath.previous" -Force }
  @{ providerInstances = @{ chat_on_steroids = $record } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $registrationPath -Encoding utf8
  $installationPath = Join-Path $InstallRoot 'installation.json'
  if (Test-Path -LiteralPath $installationPath) { Copy-Item -LiteralPath $installationPath -Destination "$installationPath.previous" -Force }
  @{release=$release;node=$resolvedNode;version=$package.version;revision=$revision;mode=$Mode;manifestSchema=1} | ConvertTo-Json | Set-Content -LiteralPath $installationPath -Encoding utf8
  Write-Output "Installed Chat on Steroids integration $($package.version)."
  Write-Output "Provider registration: $registrationPath"
  if ($RegisterT3) {
    & $resolvedNode (Join-Path $PSScriptRoot 'register-t3.mjs') "--registration=$registrationPath"
    if ($LASTEXITCODE -ne 0) { throw 'T3 provider registration refused; release is prepared, but T3 was not changed.' }
  } else {
    Write-Output 'Run scripts/register-t3.mjs or add the provider through T3 Settings.'
  }
} finally { Pop-Location }
