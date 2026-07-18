param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [int]$Port = 17368
)

$ErrorActionPreference = "Stop"

if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId must look like a Chrome extension id, for example: abcdefghijklmnopqrstuvwxyzabcdef"
}

$root = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cmdPath = Join-Path $root "native-host.generated.cmd"
$manifestPath = Join-Path $root "com.port_tabs.json"
$hostJs = Join-Path $root "host.js"

$cmd = @"
@echo off
set "PORT_TABS_PORT=$Port"
"$node" "$hostJs"
"@

Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

$manifest = [ordered]@{
  name = "com.port_tabs"
  description = "Port Tabs native host for localhost HTTP browser control."
  path = $cmdPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

$registryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.port_tabs"
& reg.exe add $registryKey /ve /t REG_SZ /d $manifestPath /f | Out-Null

Write-Host "Installed native messaging host:"
Write-Host "  $manifestPath"
Write-Host "Chrome extension allowed origin:"
Write-Host "  chrome-extension://$ExtensionId/"
Write-Host "Local API after the extension connects:"
Write-Host "  http://127.0.0.1:$Port/health"
Write-Host "  http://127.0.0.1:$Port/open-baidu"


