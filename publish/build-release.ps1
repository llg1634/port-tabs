param(
  [string]$Version = "",
  [string]$OutputRoot = "",
  [ValidateRange(1024, 65535)]
  [int]$DefaultPort = 17368
)

$ErrorActionPreference = "Stop"

function Assert-UnderPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Child,
    [Parameter(Mandatory = $true)]
    [string]$Parent
  )

  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')

  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe output path: $childFull is not under $parentFull"
  }
}

$publishRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $publishRoot

if (-not $OutputRoot) {
  $OutputRoot = Join-Path $publishRoot "dist"
}

$sourceExtension = Join-Path $repoRoot "extension"
$sourceNativeHost = Join-Path $repoRoot "native-host"
$sourceManifest = Join-Path $sourceExtension "manifest.json"

if (-not (Test-Path -LiteralPath $sourceManifest)) {
  throw "Missing extension manifest: $sourceManifest"
}

$manifest = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = [string]$manifest.version
}
if (-not $Version) {
  throw "Missing release version."
}

$target = Join-Path $OutputRoot "port-tabs-v$Version"
$targetExtension = Join-Path $target "extension"
$targetNativeHost = Join-Path $target "native-host"

Assert-UnderPath -Child $OutputRoot -Parent $publishRoot
Assert-UnderPath -Child $target -Parent $OutputRoot

if (Test-Path -LiteralPath $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $targetExtension, $targetNativeHost | Out-Null

Copy-Item -LiteralPath (Join-Path $sourceExtension "manifest.json") -Destination $targetExtension
Copy-Item -LiteralPath (Join-Path $sourceExtension "service_worker.js") -Destination $targetExtension
Copy-Item -LiteralPath (Join-Path $sourceExtension "popup.html") -Destination $targetExtension
Copy-Item -LiteralPath (Join-Path $sourceExtension "popup.js") -Destination $targetExtension
Copy-Item -LiteralPath (Join-Path $sourceNativeHost "host.js") -Destination $targetNativeHost

$installTemplate = @'
param(
  [Parameter(Mandatory = $true)]
  [string[]]$ExtensionId,

  [ValidateRange(1024, 65535)]
  [int]$Port = __DEFAULT_PORT__,

  [ValidateSet("Chrome", "Chromium", "Edge")]
  [string[]]$Browser = @("Chrome"),

  [switch]$AllSupportedBrowsers,

  [string]$NodePath = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function To-Origin {
  param([Parameter(Mandatory = $true)][string]$Value)

  $trimmed = $Value.Trim()
  if ($trimmed -match "^chrome-extension://([a-p]{32})/?$") {
    return "chrome-extension://$($Matches[1])/"
  }
  if ($trimmed -match "^[a-p]{32}$") {
    return "chrome-extension://$trimmed/"
  }
  throw "Invalid extension id/origin: $Value"
}

if ($AllSupportedBrowsers) {
  $Browser = @("Chrome", "Chromium", "Edge")
}

$nativeRoot = $PSScriptRoot
$hostJs = Join-Path $nativeRoot "host.js"
$launcherPath = Join-Path $nativeRoot "native-host.cmd"
$manifestPath = Join-Path $nativeRoot "com.port_tabs.json"

if (-not (Test-Path -LiteralPath $hostJs)) {
  throw "Missing native host file: $hostJs"
}

if ($NodePath) {
  $node = (Resolve-Path -LiteralPath $NodePath).Path
} else {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
}

$allowed = New-Object "System.Collections.Generic.HashSet[string]"
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $existing = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    foreach ($origin in @($existing.allowed_origins)) {
      if ($origin) {
        [void]$allowed.Add([string]$origin)
      }
    }
  } catch {
    Write-Warning "Existing manifest is invalid and will be overwritten."
  }
}

foreach ($id in $ExtensionId) {
  [void]$allowed.Add((To-Origin $id))
}

$launcher = @"
@echo off
set "PORT_TABS_PORT=$Port"
"$node" "$hostJs"
"@

$nativeManifest = [ordered]@{
  name = "com.port_tabs"
  description = "Port Tabs native host for localhost HTTP browser control."
  path = $launcherPath
  type = "stdio"
  allowed_origins = @($allowed)
}

$registryMap = @{
  Chrome = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.port_tabs"
  Chromium = "HKCU\Software\Chromium\NativeMessagingHosts\com.port_tabs"
  Edge = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.port_tabs"
}

$registryKeys = New-Object "System.Collections.Generic.List[string]"
foreach ($browserName in $Browser) {
  $registryKeys.Add($registryMap[$browserName])
}

if ($DryRun) {
  Write-Host "Dry run only. No files or registry values were written."
} else {
  Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ASCII
  $nativeManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  foreach ($key in $registryKeys) {
    & reg.exe add $key /ve /t REG_SZ /d $manifestPath /f | Out-Null
  }
}

Write-Host "Native host configured."
Write-Host "Manifest:"
Write-Host "  $manifestPath"
Write-Host "Launcher:"
Write-Host "  $launcherPath"
Write-Host "Host script:"
Write-Host "  $hostJs"
Write-Host "Node:"
Write-Host "  $node"
Write-Host "Allowed origins:"
foreach ($origin in $allowed) {
  Write-Host "  $origin"
}
Write-Host "Browsers:"
foreach ($browserName in $Browser) {
  Write-Host "  $browserName"
}
Write-Host "Registry values:"
foreach ($key in $registryKeys) {
  Write-Host "  $key = $manifestPath"
}
Write-Host "Default local port:"
Write-Host "  http://127.0.0.1:$Port/health"
Write-Host ""
Write-Host "Start the browser or reload the extension. The browser will auto-start this native host."
'@

$uninstallScript = @'
param(
  [ValidateSet("Chrome", "Chromium", "Edge")]
  [string[]]$Browser = @("Chrome"),

  [switch]$AllSupportedBrowsers
)

$ErrorActionPreference = "Stop"

if ($AllSupportedBrowsers) {
  $Browser = @("Chrome", "Chromium", "Edge")
}

$registryMap = @{
  Chrome = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.port_tabs"
  Chromium = "HKCU\Software\Chromium\NativeMessagingHosts\com.port_tabs"
  Edge = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.port_tabs"
}

foreach ($browserName in $Browser) {
  $key = $registryMap[$browserName]
  & reg.exe delete $key /ve /f 2>$null | Out-Null
  Write-Host "Removed native host registry value:"
  Write-Host "  $key"
}

Write-Host "The extension folder and native-host files were not deleted."
'@

$readmeTemplate = @'
# Port Tabs Release __VERSION__

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

[中文说明](README.zh-CN.md)

## About

Port Tabs turns the current browser/profile into a localhost HTTP control port. Terminals and local programs can operate real tabs, page scripts, CDP, Network, Console, screenshots, input debugging, shadow DOM tools, recorder data, cookies, history, bookmarks, downloads, and storage through that port.

This release has only two required parts:

```text
extension/      Load this folder in the browser.
native-host/    Run install.ps1 here to configure native messaging and registry.
```

There is no MCP server. After configuration, the browser starts the native host automatically when the extension connects.

## Install

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this release's `extension/` folder.
5. Copy the extension ID shown by the browser.
6. Run:

```powershell
.\native-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID -Port __DEFAULT_PORT__ -Browser Chrome
```

For Edge:

```powershell
.\native-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID -Port __DEFAULT_PORT__ -Browser Edge
```

For Chrome Stable/Beta/Dev/Canary, use `-Browser Chrome`. If several browser profiles produce different extension IDs, pass all of them:

```powershell
.\native-host\install.ps1 -ExtensionId ID1,ID2 -Port 17368 -Browser Chrome
```

## Multiple Browsers

Each browser/profile can set a different port and name in the popup:

```text
Chrome Dev profile -> 127.0.0.1:17368
Chrome Stable      -> 127.0.0.1:17369
Edge test          -> 127.0.0.1:17370
```

## Auto Start

Normal startup flow:

```text
open browser
  -> extension wakes/connects
  -> Chrome Native Messaging launches native-host/native-host.cmd
  -> host.js opens 127.0.0.1:<configured port>
```

If the port is not listening, open the extension popup and click `Reconnect`, or reload the extension in `chrome://extensions/`.

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:__DEFAULT_PORT__/health
Invoke-WebRequest http://127.0.0.1:__DEFAULT_PORT__/help
```

## Uninstall Native Host Registration

```powershell
.\native-host\uninstall.ps1 -Browser Chrome
```

## Important

- The HTTP server binds to `127.0.0.1` only.
- Any local process can call the configured port.
- This is a local browser-control/debugging backend with tabs, page eval, CDP, network, console, screenshot, input, shadow DOM, recorder, cookies, history, bookmarks, and storage APIs.
- `/eval fetch(...)` is equivalent to F12 Console `fetch(...)` and follows normal browser CORS rules.
'@

$readmeZhTemplate = @'
# Port Tabs 发布版 __VERSION__

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

发布目录结构：

```text
extension/      浏览器加载这个扩展目录
native-host/    运行 install.ps1，自动生成 Native Messaging 配置并写注册表
```

## 安装

发布版安装分两步：先加载扩展，再注册 native host。

第一步，加载扩展：

1. 打开浏览器的 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本发布目录里的 `extension/`。
5. 在扩展卡片上复制浏览器显示的扩展 ID。

第二步，注册 native host：

1. 打开 PowerShell。
2. 进入本发布目录，例如：

```powershell
cd D:\Users\Administrator\Desktop\renwu2\260706\publish\dist\port-tabs-v__VERSION__
```

3. 使用刚才复制的扩展 ID 运行：

```powershell
.\native-host\install.ps1 -ExtensionId 你的扩展ID -Port __DEFAULT_PORT__ -Browser Chrome
```

Edge 用：

```powershell
.\native-host\install.ps1 -ExtensionId 你的扩展ID -Port __DEFAULT_PORT__ -Browser Edge
```

Chrome Stable/Beta/Dev/Canary 都用 `-Browser Chrome`。如果多个浏览器/profile 加载后扩展 ID 不一样，可以一次传多个：

```powershell
.\native-host\install.ps1 -ExtensionId ID1,ID2 -Port 17368 -Browser Chrome
```

安装脚本会自动生成：

```text
native-host/com.port_tabs.json
native-host/native-host.cmd
```

并写入对应浏览器的 Native Messaging 注册表项。

## 多浏览器

每个浏览器/profile 都可以在扩展 Popup 里设置自己的端口和名称：

```text
Chrome Dev 默认资料 -> 127.0.0.1:17368
Chrome Stable      -> 127.0.0.1:17369
Edge 测试资料       -> 127.0.0.1:17370
```

调用端口时就是控制对应的浏览器/profile。

## 自动启动逻辑

```text
打开浏览器
  -> 扩展启动或被唤醒
  -> 扩展 connectNative
  -> 浏览器自动启动 native-host/native-host.cmd
  -> host.js 监听 127.0.0.1:<端口>
```

如果端口没起来，打开扩展 Popup 点 `Reconnect`，或者在 `chrome://extensions/` 刷新扩展。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:__DEFAULT_PORT__/health
Invoke-WebRequest http://127.0.0.1:__DEFAULT_PORT__/help
```

也可以先只模拟安装，不写文件、不写注册表：

```powershell
.\native-host\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -Port __DEFAULT_PORT__ -Browser Chrome -DryRun
```

## 卸载 Native Host 注册

```powershell
.\native-host\uninstall.ps1 -Browser Chrome
```

## 注意

- HTTP 服务只监听 `127.0.0.1`。
- 本机任意进程都可以调用这个端口。
- 这是本地浏览器控制/调试后端，支持 tab、页面 eval、CDP、network、console、截图、输入、shadow DOM、recorder、cookies、history、bookmarks、storage 等。
- `/eval fetch(...)` 等价于 F12 Console 里的 `fetch(...)`，遵守正常浏览器 CORS 规则。
'@

$installScript = $installTemplate.Replace("__DEFAULT_PORT__", [string]$DefaultPort)
$releaseReadme = $readmeTemplate.
  Replace("__VERSION__", $Version).
  Replace("__DEFAULT_PORT__", [string]$DefaultPort)
$releaseReadmeZh = $readmeZhTemplate.
  Replace("__VERSION__", $Version).
  Replace("__DEFAULT_PORT__", [string]$DefaultPort)

Set-Content -LiteralPath (Join-Path $targetNativeHost "install.ps1") -Value $installScript -Encoding ASCII
Set-Content -LiteralPath (Join-Path $targetNativeHost "uninstall.ps1") -Value $uninstallScript -Encoding ASCII
Set-Content -LiteralPath (Join-Path $target "README.md") -Value $releaseReadme -Encoding UTF8
Set-Content -LiteralPath (Join-Path $target "README.zh-CN.md") -Value $releaseReadmeZh -Encoding UTF8
Set-Content -LiteralPath (Join-Path $target "VERSION.txt") -Value "Port Tabs $Version`nDefaultPort: $DefaultPort`n" -Encoding ASCII

Write-Host "Release folder generated:"
Write-Host "  $target"
Write-Host ""
Write-Host "Use:"
Write-Host "  1. Load unpacked: $targetExtension"
Write-Host "  2. Run: .\native-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID -Port $DefaultPort -Browser Chrome"


