$ErrorActionPreference = "Stop"

$registryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.port_tabs"
& reg.exe delete $registryKey /ve /f 2>$null | Out-Null

Write-Host "Removed native messaging host registry value:"
Write-Host "  $registryKey"

