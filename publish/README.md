# Publish

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

[中文发布说明](README.zh-CN.md)

## About

This folder only generates the release folder from the current project files.

Project folders copied into the release:

```text
extension/
native-host/
README.md
```

Release output:

```text
publish/dist/port-tabs-vVERSION/
  extension/
  native-host/
  README.md
  VERSION.txt
```

That is the intended release model:

```text
1. extension/
   Browser loads this folder.

2. native-host/
   install.ps1 writes the Native Messaging manifest, launcher cmd, and registry entry.
```

No MCP server is involved. After native-host registration, the browser auto-starts the host when the extension connects through Chrome Native Messaging.

## Build

Run from the project root:

```powershell
.\publish\build-release.ps1
```

The script reads the version from `extension/manifest.json` and generates:

```text
publish/dist/port-tabs-v0.3.2/
  extension/
    manifest.json
    service_worker.js
    popup.html
    popup.js
  native-host/
    host.js
    install.ps1
    uninstall.ps1
  README.md
  VERSION.txt
```

## Install From Release

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Load `publish/dist/port-tabs-vVERSION/extension`.
4. Copy the extension ID shown by the browser.
5. Run from the release folder:

```powershell
.\native-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID -Port 17368 -Browser Chrome
```

Use `-Browser Chrome` for Google Chrome Stable/Beta/Dev/Canary, `-Browser Edge` for Microsoft Edge, and `-Browser Chromium` for Chromium.

If multiple browser profiles produce different extension IDs, pass all IDs:

```powershell
.\native-host\install.ps1 -ExtensionId ID1,ID2 -Port 17368 -Browser Chrome
```

The extension popup can then set a different port/name per browser profile.

