param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$ReleaseName,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'T3-CoS-Integration'),
  [string]$NodePath,
  [ValidateSet('modern','existing-install')][string]$Mode = 'modern',
  [switch]$AutoStartMain
)
$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'releases')).TrimEnd('\') + '\'
$release = [IO.Path]::GetFullPath((Join-Path $releaseRoot $ReleaseName))
if (-not $release.StartsWith($releaseRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid release path.' }
if (-not $NodePath) {
  $existing = Join-Path $InstallRoot 'installation.json'
  if (Test-Path -LiteralPath $existing) {
    try {
      $candidate = (Get-Content -LiteralPath $existing -Raw | ConvertFrom-Json).node
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { $NodePath = $candidate }
    } catch {}
  }
  if (-not $NodePath) {
    $found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($found) { $NodePath = $found.Source }
  }
}
if (-not $NodePath) { throw 'Node.js 24 or later is required. Install Node.js or pass -NodePath.' }
$node = (Resolve-Path -LiteralPath $NodePath).Path
$tools = Join-Path $PSScriptRoot 'release-tools.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $release 'release-manifest.json'))) { throw 'This older release has no verified rollback manifest. It cannot be selected automatically.' }
$database = Join-Path $InstallRoot 'state/state.sqlite'
$arguments = @($tools,'preflight',$release,$node)
if (Test-Path -LiteralPath $database) { $arguments += $database }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Rollback compatibility check failed. No registration was changed.' }
$record = @{ driver='acpRegistry';displayName='Chat on Steroids';enabled=$true;environment=@(@{name='COS_ACP_MODE';sensitive=$false;value=$Mode},@{name='COS_ACP_HOME';sensitive=$false;value=(Join-Path $InstallRoot 'state')});config=@{source='local';commandPath=$node;commandArgs=@('--disable-warning=ExperimentalWarning',(Join-Path $release 'dist/cli.js'));integration='chat-on-steroids';customModels=@()} }
$registration = Join-Path $InstallRoot 'provider-registration.json'
if ($AutoStartMain) {
  if ($Mode -ne 'existing-install') { throw 'Automatic main-app startup requires existing-install mode.' }
  $record.environment += @{name='COS_ACP_AUTOSTART';value='1';sensitive=$false}
}
if (Test-Path -LiteralPath $registration) { Copy-Item -LiteralPath $registration -Destination "$registration.previous" -Force }
@{providerInstances=@{chat_on_steroids=$record}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $registration -Encoding utf8
Write-Output 'Verified rollback registration prepared. Apply it through T3 Settings after disabling and draining the provider.'
Write-Output 'CoS, its login, T3 settings, and adapter conversation state were not modified.'
