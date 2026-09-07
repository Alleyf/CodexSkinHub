[CmdletBinding()]
param(
  # Wait this long for a Codex Desktop instance to expose its CDP endpoint.
  [int]$WaitSeconds = 0,
  # Restart the injector even when it is already attached to the detected port.
  [switch]$Force,
  [int]$PollIntervalMs = 1000
)

<#
  Aligns Codex Dream Skin with whatever Codex Desktop instance is running right
  now, including instances started by `codexhost`.

  Background: Dream Skin themes are injected at runtime over CDP, so the running
  Codex must expose a loopback debugging endpoint and the injector must be
  pointed at that exact port. Dream Skin defaults to 9335 and only starts Codex
  itself with --remote-debugging-port=9335. codexhost starts Codex with its own
  dynamically chosen port, so the default injector never sees that instance and
  stops instead of reconnecting.

  This script discovers the live CDP endpoint, restarts the injector against it
  and records the port in state.json. It never restarts Codex and never edits
  protected app files.
#>

$ErrorActionPreference = 'Stop'

# [codexskin] Self-heal: npm update/install of @codexhost/cli wipes the Dream
# Skin patches. Re-apply them (idempotent no-op when already patched) so the
# in-app settings page and the theme CLI survive package updates.
$StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$PatchScript = Join-Path $StateRoot 'patch-codexhost.mjs'
if (Test-Path $PatchScript) {
  $PatchNode = Join-Path $StateRoot 'engine\runtime\node\node.exe'
  if (-not (Test-Path $PatchNode)) { $PatchNode = 'node' }
  & $PatchNode $PatchScript 2>$null | Out-Null
}

$StateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$Engine    = Join-Path $StateRoot 'engine'
$Node      = Join-Path $Engine 'runtime\node\node.exe'
$Injector  = Join-Path $Engine 'scripts\injector.mjs'
$ThemeDir  = Join-Path $StateRoot 'active-theme'
$PauseFile = Join-Path $StateRoot 'paused'
$StatePath = Join-Path $StateRoot 'state.json'
$StdoutLog = Join-Path $StateRoot 'injector.log'
$StderrLog = Join-Path $StateRoot 'injector-error.log'

foreach ($required in @($Node, $Injector, $ThemeDir)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Dream Skin engine is incomplete, missing: $required"
  }
}

function Get-CodexProcessIds {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { [int]$_.ProcessId })
}

function Get-CodexCdpEndpoint {
  $pids = Get-CodexProcessIds
  if ($pids.Count -eq 0) { return $null }
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object {
      ($pids -contains [int]$_.OwningProcess) -and
      ($_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1')
    })
  foreach ($listener in $listeners) {
    $port = [int]$listener.LocalPort
    try {
      # Bypass any system proxy: the endpoint is loopback-only.
      $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/json/version")
      $request.Proxy = $null
      $request.Timeout = 2000
      $response = $request.GetResponse()
      try {
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
        $payload = $reader.ReadToEnd() | ConvertFrom-Json
      } finally {
        $response.Close()
      }
      $webSocket = [string]$payload.webSocketDebuggerUrl
      if ($webSocket -match '^ws://127\.0\.0\.1:(\d+)/devtools/browser/([A-Za-z0-9._-]+)$') {
        return [pscustomobject]@{
          Port      = [int]$Matches[1]
          BrowserId = $Matches[2]
          Browser   = [string]$payload.Browser
        }
      }
    } catch {
      continue
    }
  }
  return $null
}

function Get-RunningInjectorId {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  if ($process.CommandLine -notmatch 'injector\.mjs') { return $null }
  return $ProcessId
}

function Read-DreamSkinStateFile {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  try {
    return (Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$endpoint = Get-CodexCdpEndpoint
if ($null -eq $endpoint -and $WaitSeconds -gt 0) {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  Write-Host "Waiting up to $WaitSeconds seconds for the Codex Desktop CDP endpoint..."
  while ($null -eq $endpoint -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $PollIntervalMs
    $endpoint = Get-CodexCdpEndpoint
  }
}

if ($null -eq $endpoint) {
  throw 'No running Codex Desktop CDP endpoint found. Start Codex first (e.g. via codexhost), then run this script again.'
}

Write-Host ("Codex CDP endpoint found: port {0} / browser {1} ({2})" -f $endpoint.Port, $endpoint.BrowserId, $endpoint.Browser)

$state = Read-DreamSkinStateFile
$savedPort = if ($state -and $state.port) { [int]$state.port } else { 0 }
$savedPid  = if ($state -and $state.injectorPid) { [int]$state.injectorPid } else { 0 }
$liveInjector = Get-RunningInjectorId -ProcessId $savedPid

if (-not $Force -and $liveInjector -and $savedPort -eq $endpoint.Port) {
  Write-Host "Injector is already running on port $($endpoint.Port) (PID $liveInjector). Nothing to do."
  return
}

if ($liveInjector) {
  Stop-Process -Id $liveInjector -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped old injector (PID $liveInjector, port $savedPort)."
}

$argumentList = @(
  '"' + $Injector + '"',
  '--port', "$($endpoint.Port)",
  '--browser-id', $endpoint.BrowserId,
  '--theme-dir', '"' + $ThemeDir + '"',
  '--pause-file', '"' + $PauseFile + '"',
  '--watch'
) -join ' '

$process = Start-Process -FilePath $Node -ArgumentList $argumentList `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog

Start-Sleep -Milliseconds 1500

if ($state) {
  $state.port = $endpoint.Port
  $state.browserId = $endpoint.BrowserId
  $state.injectorPid = $process.Id
  $state.injectorStartedAt = (Get-Date).ToUniversalTime().ToString('o')
  # Write UTF-8 WITHOUT BOM: Windows PowerShell 5.1's `-Encoding UTF8` emits a
  # BOM that can break the JSON readers of the Dream Skin app itself.
  $json = ($state | ConvertTo-Json -Depth 8)
  [System.IO.File]::WriteAllText($StatePath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}

Write-Host ("Theme injector aligned to port {0} (PID {1})." -f $endpoint.Port, $process.Id)
Write-Host "Logs: $StdoutLog / $StderrLog"
Write-Host 'Done. You can close this window.'
