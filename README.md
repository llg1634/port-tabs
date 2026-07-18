# Port Tabs

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

[中文说明](README.zh-CN.md)

## About

Port Tabs turns an installed Chrome/Chromium profile into a localhost HTTP control backend. It keeps the real browser state: logged-in accounts, cookies, tabs, windows, history, bookmarks, downloads, page scripts, CDP, Network, Console, screenshots, input debugging, shadow DOM inspection, and event recording.

Current version: `0.3.2`

It is not an MCP server. Any local program can call `127.0.0.1:17368` with HTTP JSON and control the Chrome profile where the extension is installed. The browser keeps its normal state: logged-in accounts, cookies, windows, tabs, history, bookmarks, and downloads.

```text
curl / Python / Node / desktop app / agent
  -> http://127.0.0.1:17368
  -> native-host/host.js
  -> Chrome Native Messaging
  -> extension/service_worker.js
  -> chrome.tabs / chrome.scripting / chrome.debugger / downloads / history / bookmarks / cookies
```

## Requirements

- Windows
- Chrome
- Node.js available as `node.exe`

## Install From Release Zip

Download `port-tabs-v0.3.2.zip` from GitHub Releases and unzip it. The unpacked folder contains:

```text
port-tabs-v0.3.2/
  extension/
  native-host/
  README.md
  README.zh-CN.md
  VERSION.txt
```

1. Open Chrome and go to `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `port-tabs-v0.3.2/extension`.
5. Copy the extension ID shown by Chrome.
6. Run PowerShell from the unpacked `port-tabs-v0.3.2` folder:

```powershell
.\native-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID -Port 17368 -Browser Chrome
```

Use `-Browser Chrome` for Chrome Stable/Beta/Dev/Canary. Use `-Browser Edge` for Microsoft Edge.

`install.ps1` exists in the Release zip's `native-host/` folder. In the source repository, use `install-host.ps1` instead.

## Install From Source

1. Open Chrome and go to `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension` folder in this project.
5. Copy the extension ID shown by Chrome.
6. Run PowerShell from this project directory:

```powershell
.\native-host\install-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

7. Reload the extension in `chrome://extensions/`.

## Build Release Folder From Source

`publish/` only generates the folder intended for release. It does not add a separate source package or hidden service layer.

```powershell
.\publish\build-release.ps1
```

Generated files go to `publish/dist/port-tabs-vVERSION/` and are intentionally only the directly inspectable runtime parts:

```text
extension/      Browser loads this folder.
native-host/    install.ps1 writes Native Messaging manifest, launcher cmd, and registry.
```

The extension is loaded unpacked, and the local host code/scripts are plain files in `native-host/`. See `publish/README.md` for the release workflow. After configuration, the browser starts the native host automatically through Chrome Native Messaging when the extension connects.

## Model

- No MCP.
- No caller sessions.
- No isolation layer.
- No special Chrome launch flags.
- If `tabId` is omitted, commands use the current active tab.
- If `tabId` is provided, commands target that specific tab.
- The extension popup can configure the local HTTP port for this browser/profile.

## Popup Port Config

Click the extension icon, enter a port, optional browser name, optional note, and click `Save`.

Each browser/profile stores its own port in `chrome.storage.local`, so multiple browsers can be controlled independently:

```text
Chrome Dev Default -> 127.0.0.1:17368
Chrome Stable      -> 127.0.0.1:17369
Edge               -> 127.0.0.1:17370
```

The name/note are also stored per browser/profile. They are only human-readable labels, not sessions, leases, isolation, or authentication. `GET /health`, `GET /schema`, and `GET /help` show the current label so you can tell which browser a port controls.

The native host does not listen until the extension sends its configured port. Changing the port in popup tells the already-running native host to rebind the HTTP server.

## Core API

Discovery:

```powershell
Invoke-WebRequest http://127.0.0.1:17368/help
Invoke-RestMethod http://127.0.0.1:17368/schema
Invoke-RestMethod http://127.0.0.1:17368/openapi.json
```

Check status:

```powershell
Invoke-RestMethod http://127.0.0.1:17368/health
```

Open a URL:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/open `
  -ContentType "application/json" `
  -Body '{"url":"https://www.baidu.com/"}'
```

List tabs and get active tab:

```powershell
Invoke-RestMethod http://127.0.0.1:17368/tabs
Invoke-RestMethod http://127.0.0.1:17368/tab
```

Navigate, reload, back, forward, close:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/goto -ContentType "application/json" -Body '{"url":"https://example.com"}'
Invoke-RestMethod -Method Post http://127.0.0.1:17368/reload -ContentType "application/json" -Body '{}'
Invoke-RestMethod -Method Post http://127.0.0.1:17368/back -ContentType "application/json" -Body '{}'
Invoke-RestMethod -Method Post http://127.0.0.1:17368/forward -ContentType "application/json" -Body '{}'
Invoke-RestMethod -Method Post http://127.0.0.1:17368/close -ContentType "application/json" -Body '{}'
```

Page actions:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/fill `
  -ContentType "application/json" `
  -Body '{"selector":"#kw","value":"port tabs"}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/click `
  -ContentType "application/json" `
  -Body '{"selector":"#su"}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/wait `
  -ContentType "application/json" `
  -Body '{"text":"百度搜索","timeout":5000}'
```

Evaluate JavaScript:

`/eval` defaults to `world: "MAIN"`, so it can see page globals and open shadow DOM the same way page scripts do. Pass `world: "ISOLATED"` only when you intentionally want Chrome's isolated extension world.

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/eval `
  -ContentType "application/json" `
  -Body '{"expression":"document.title"}'
```

Read page content and interactive elements:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/content `
  -ContentType "application/json" `
  -Body '{"maxText":1000,"maxLinks":20,"maxImages":20}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/interactive `
  -ContentType "application/json" `
  -Body '{"limit":50}'
```

Call Chrome DevTools Protocol:

```powershell
$body = @{
  method = "Runtime.evaluate"
  params = @{
    expression = "location.href"
    returnByValue = $true
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post http://127.0.0.1:17368/cdp `
  -ContentType "application/json" `
  -Body $body
```

CDP input debugging:

`/input/wheel` first tries Chrome DevTools Protocol `Input.dispatchMouseEvent`. If Chrome does not call back quickly, it falls back to a page-side `WheelEvent` and manual scrolling of the nearest scrollable ancestor. The response includes `cdp.ok`, `cdp.timeout`, the fallback target, and `scroller.before/after` so you can tell whether scrolling actually happened.

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/input/wheel `
  -ContentType "application/json" `
  -Body '{"x":300,"y":300,"deltaY":120,"cdpTimeoutMs":1200}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/input/drag `
  -ContentType "application/json" `
  -Body '{"from":{"x":200,"y":300},"to":{"x":500,"y":300},"steps":20}'
```

CDP event cache and native event stream:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/network/start -ContentType "application/json" -Body '{}'
Invoke-RestMethod http://127.0.0.1:17368/cdp/events
Invoke-RestMethod http://127.0.0.1:17368/events
curl.exe -N http://127.0.0.1:17368/events/stream?channel=cdp
```

Shadow DOM, frames, and element debugging:

These helpers run in `MAIN` by default. `/shadow/query` searches normal DOM, open shadow roots, and same-origin frames. `/element/from-point` and coordinate-based `/element/inspect` deep hit-test through open shadow roots and return a `chain` that shows each pierced host.

```powershell
Invoke-RestMethod http://127.0.0.1:17368/frames

Invoke-RestMethod -Method Post http://127.0.0.1:17368/shadow/query `
  -ContentType "application/json" `
  -Body '{"selector":"button","limit":20}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/element/inspect `
  -ContentType "application/json" `
  -Body '{"selector":"#kw"}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/element/from-point `
  -ContentType "application/json" `
  -Body '{"x":500,"y":500}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/element/highlight `
  -ContentType "application/json" `
  -Body '{"selector":"#kw","duration":3000}'
```

Input event recorder:

Use `tabId` when the active tab is `chrome://extensions/` or another internal page. The recorder captures pointer, mouse, wheel, scroll, key, and input events. For shadow DOM events it reports the deepest target when `composedPath()` exposes one, plus `retargetSelector` when the browser retargeted the event to a shadow host.

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/recorder/start -ContentType "application/json" -Body '{}'
Invoke-RestMethod http://127.0.0.1:17368/recorder
Invoke-RestMethod -Method Post http://127.0.0.1:17368/recorder/stop -ContentType "application/json" -Body '{}'
```

Typical page-bug workflow:

```powershell
# 1. Find the real target tab. Do not inject into chrome:// pages.
Invoke-RestMethod http://127.0.0.1:17368/tabs

# 2. Start recorder on a specific tab.
Invoke-RestMethod -Method Post http://127.0.0.1:17368/recorder/start `
  -ContentType "application/json" `
  -Body '{"tabId":123,"clear":true}'

# 3. Find the deepest element under the cursor coordinate.
Invoke-RestMethod -Method Post http://127.0.0.1:17368/element/from-point `
  -ContentType "application/json" `
  -Body '{"tabId":123,"x":500,"y":500}'

# 4. Try wheel input and inspect the fallback scroller state.
Invoke-RestMethod -Method Post http://127.0.0.1:17368/input/wheel `
  -ContentType "application/json" `
  -Body '{"tabId":123,"x":500,"y":500,"deltaY":240}'

# 5. Read event evidence.
Invoke-RestMethod "http://127.0.0.1:17368/recorder?tabId=123"
Invoke-RestMethod http://127.0.0.1:17368/cdp/events
```

Save a screenshot:

```powershell
$body = @{
  path = "$PWD\out\page.png"
  omitData = $true
} | ConvertTo-Json

Invoke-RestMethod -Method Post http://127.0.0.1:17368/screenshot `
  -ContentType "application/json" `
  -Body $body
```

Network and console:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/network/start -ContentType "application/json" -Body '{}'
Invoke-RestMethod http://127.0.0.1:17368/network

Invoke-RestMethod -Method Post http://127.0.0.1:17368/console/start -ContentType "application/json" -Body '{}'
Invoke-RestMethod http://127.0.0.1:17368/console
```

Network search and filters:

`/network` returns aggregated request rows instead of forcing you to inspect every raw `Network.*` event. Use filters to find the requestId first, then call `/network/detail` or `/network/body`.

```powershell
# Global fuzzy search across URL, requestId, method, status, type, mime, headers, and postData preview.
Invoke-RestMethod "http://127.0.0.1:17368/network?search=comment&limit=20"

# DevTools-style filters.
Invoke-RestMethod "http://127.0.0.1:17368/network?type=Fetch&method=POST&status=2xx"
Invoke-RestMethod "http://127.0.0.1:17368/network?domain=bilibili.com&url=reply"
Invoke-RestMethod "http://127.0.0.1:17368/network?failed=true"
Invoke-RestMethod "http://127.0.0.1:17368/network?hasBody=true&mimeType=json"

# Inspect one request and then read its response body.
Invoke-RestMethod "http://127.0.0.1:17368/network/detail?requestId=REQUEST_ID"
Invoke-RestMethod "http://127.0.0.1:17368/network/body?requestId=REQUEST_ID"

# Include raw CDP events for the returned rows when needed.
Invoke-RestMethod "http://127.0.0.1:17368/network?search=api&raw=true"
```

Useful `/network` query parameters:

```text
search      Fuzzy search across common request fields.
url         URL substring filter.
domain      Hostname substring filter.
method      GET, POST, PUT, DELETE, etc.
status      Exact status or range: 2xx, 3xx, 4xx, 5xx.
type        Fetch, XHR, Document, Script, Stylesheet, Image, Media, Font, WebSocket, Other.
failed      true means Network.loadingFailed or HTTP status >= 400.
hasBody     true means a response was observed and /network/body may work.
requestId   Find one requestId.
tabId       Only show requests from one tab.
limit       Page size, default 100.
offset      Pagination offset.
raw         Include raw CDP events for returned rows.
```

Fetch and CORS rules:

`/eval fetch(...)` is the same kind of fetch as running `fetch(...)` in F12 Console. It runs inside the current page, so it follows normal browser rules: Origin, CORS, cookies, credentials, CSP, and page security rules.

If you want the request to run under a different Origin, open a new tab at that Origin first, then run `/eval fetch` in that tab. If you do not want page CORS at all, use terminal requests or add/use a native-host HTTP request endpoint. That is a different request environment: it does not follow page CORS, but it also does not automatically match browser cookies, Origin, Referer, or login state. This difference is normal browser behavior, not a tool defect.

Cookies, history, bookmarks, downloads:

```powershell
Invoke-RestMethod "http://127.0.0.1:17368/cookies?url=https%3A%2F%2Fwww.baidu.com%2F"
Invoke-RestMethod "http://127.0.0.1:17368/history?text=baidu&maxResults=5"
Invoke-RestMethod "http://127.0.0.1:17368/bookmarks?query=baidu"
Invoke-RestMethod http://127.0.0.1:17368/downloads
```

Page storage:

```powershell
Invoke-RestMethod "http://127.0.0.1:17368/storage?area=localStorage"

Invoke-RestMethod -Method Post http://127.0.0.1:17368/storage `
  -ContentType "application/json" `
  -Body '{"area":"localStorage","key":"sample","value":"ok"}'
```

## Uninstall

```powershell
.\native-host\uninstall-host.ps1
```
