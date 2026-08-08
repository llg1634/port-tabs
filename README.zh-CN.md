# Port Tabs 中文说明

搜索关键词：Agent 控制浏览器、Agent 自动化浏览器、多 Agent 浏览器控制、多 Agent 浏览器自动化、浏览器自动化、浏览器自动化工具、浏览器调试扩展、浏览器控制扩展、浏览器调试插件、浏览器控制插件、浏览器 HTTP 控制端口、浏览器控制端口、Chrome 调试扩展、Chrome 控制端口、AI 怎么控制浏览器、怎么用程序控制 Chrome 标签页、怎么通过 HTTP 控制浏览器、本地端口控制浏览器、操作真实标签页、CDP 控制浏览器、执行页面脚本、MCP Chrome 替代、Port Tabs、Port Tabs 扩展。agent controlled browser, agent browser automation, multi-agent browser control, multi-agent browser automation, browser automation, browser automation tool, browser debugging extension, browser control extension, browser debugging plugin, browser control plugin, browser HTTP control port, browser control port, Chrome debugging extension, Chrome control port, how AI controls browser, control Chrome tabs programmatically, control browser over HTTP, control browser via local port, control real tabs, CDP browser control, run page scripts, MCP Chrome alternative, Port Tabs, Port Tabs extension.

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。主要用于多 Agent 协作，可替代 MCP Chrome 等其他浏览器控制插件。

[English README](README.md)

## 定位

Port Tabs 是一个本地浏览器控制后端。浏览器加载扩展后，扩展通过 Chrome Native Messaging 自动启动本地 native host，native host 在 `127.0.0.1:<端口>` 提供 HTTP JSON API。

它不是 MCP，不需要连接 MCP 服务。打开浏览器后，扩展会自动连接 native host；不同浏览器/profile 可以在 Popup 里配置不同端口和名称。

## 功能

- 控制真实标签页：打开、跳转、刷新、关闭、激活。
- 执行页面脚本：`/eval` 默认运行在页面 `MAIN` world。
- 调用 CDP：`/cdp`、截图、输入、Network、Console。
- 调试页面：shadow DOM 查询、元素坐标/样式、from-point 深度命中、元素高亮、事件 recorder。
- 读取浏览器状态：cookies、history、bookmarks、downloads、storage。
- Network 检索：按 `search/url/domain/method/status/type/failed/hasBody/requestId` 过滤请求，再用 `/network/body` 取响应体。
- 对新建标签页和刷新标签页提供 30 秒滑动窗口软提醒或硬拦截。

## 环境要求

- Windows
- Chrome
- 可以通过 `node.exe` 找到的 Node.js

## 安装

从 GitHub Tag/Release 页面下载 Source code 压缩包，或者直接克隆仓库。仓库本身就是可安装版本，不再区分源码目录和另外生成的发布目录。

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择仓库里的 `extension/`。
5. 复制浏览器显示的扩展 ID。
6. 在仓库根目录运行：

```powershell
.\native-host\install-host.ps1 -ExtensionId 你的扩展ID -Port 17368
```

7. 回到 `chrome://extensions/` 重新加载扩展。

安装脚本写入 Chrome Native Messaging 注册，并记录 `node.exe` 和 `native-host/host.js` 的绝对路径。移动仓库、更换 Node.js/NVM 路径或扩展 ID 变化后，需要重新运行安装脚本。`-Port` 是启动回退端口，扩展连接后以 Popup 保存的端口为准。

当前安装脚本只写 Google Chrome 的 Native Messaging 注册表项，不接受 `-Browser` 参数，也不会写 Edge 或 Chromium 专用注册表项。

## Popup 配置

Popup 可以为当前浏览器/profile 保存端口、名称、备注、风控模式和次数阈值。不同浏览器/profile 应使用不同端口；如果多个 Host 监听同一端口，后启动的实例会遇到端口占用错误。

名称和备注只是方便识别浏览器的标签，不是会话、鉴权或隔离机制。修改端口后，已经运行的 Native Host 会重新绑定 HTTP 服务。

## 自动化风控提醒

- `Off`：关闭提醒和拦截。
- `Soft`：超过阈值后仍执行请求，同时在响应中增加 `AUTOMATION_RATE_WARNING`。
- `Hard`：超过阈值后不执行请求，返回 `ok: false`、`blocked: true`、warning 和 `retryAfterMs`。
- 新建标签页和刷新标签页共享同一个计数。
- 窗口是连续滑动的 30 秒。阈值为 `5` 时，前 5 次正常，第 6 次开始提醒或拦截。
- Soft 模式不会自动 sleep，也不会主动延迟请求，只提示调用方降低突发频率或复用已有标签页。
- Hard 模式中被拦截的请求不会加入计数，也不会延长窗口。
- 修改模式或阈值会清空当前窗口；配置按浏览器/profile 保存，计数只保留在当前浏览器会话中。

硬拦截目前会返回 HTTP `500`，因为 Native Host 将所有 `ok: false` 结果统一映射为错误响应。响应 JSON 仍包含完整 warning 和最短 `retryAfterMs`，调用方不应把它替换成固定等待 30 秒。

## 自动启动

```text
  打开浏览器
  -> 扩展启动或被唤醒
  -> 扩展 connectNative
  -> 浏览器自动启动 native-host/native-host.generated.cmd
  -> host.js 监听 127.0.0.1:<端口>
```

如果端口没有起来，打开扩展 Popup 点 `Reconnect`，或者在 `chrome://extensions/` 刷新扩展。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:17368/health
Invoke-WebRequest http://127.0.0.1:17368/help
```

## 常见工作流

### 标签页操作

先列出标签页并找到目标 `tabId`，再对指定标签页执行操作。省略 `tabId` 时，命令默认使用当前活动标签页。

```powershell
Invoke-RestMethod http://127.0.0.1:17368/tabs

Invoke-RestMethod -Method Post http://127.0.0.1:17368/open `
  -ContentType "application/json" `
  -Body '{"url":"https://www.baidu.com/"}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/goto `
  -ContentType "application/json" `
  -Body '{"tabId":123,"url":"https://example.com/"}'

Invoke-RestMethod -Method Post http://127.0.0.1:17368/reload `
  -ContentType "application/json" `
  -Body '{"tabId":123}'
```

### 页面问题调试

不要向 `chrome://` 或 `edge://` 页面注入脚本。先找到真实网页的 `tabId`，再启动 recorder、定位坐标下的深层元素、发送滚轮输入，最后读取事件证据。

```powershell
# 1. 查找真实目标标签页。
Invoke-RestMethod http://127.0.0.1:17368/tabs

# 2. 在指定标签页启动事件 recorder。
Invoke-RestMethod -Method Post http://127.0.0.1:17368/recorder/start `
  -ContentType "application/json" `
  -Body '{"tabId":123,"clear":true}'

# 3. 查找坐标下经过 open shadow DOM 穿透后的最深元素。
Invoke-RestMethod -Method Post http://127.0.0.1:17368/element/from-point `
  -ContentType "application/json" `
  -Body '{"tabId":123,"x":500,"y":500}'

# 4. 发送滚轮输入，并检查响应中的 CDP 和 fallback scroller 状态。
Invoke-RestMethod -Method Post http://127.0.0.1:17368/input/wheel `
  -ContentType "application/json" `
  -Body '{"tabId":123,"x":500,"y":500,"deltaY":240}'

# 5. 读取 recorder 和 CDP 事件。
Invoke-RestMethod "http://127.0.0.1:17368/recorder?tabId=123"
Invoke-RestMethod http://127.0.0.1:17368/cdp/events
```

### 保存截图

`path` 由 Native Host 按当前 Windows 用户权限写入本地文件。

```powershell
$body = @{
  tabId = 123
  path = "$PWD\out\page.png"
  omitData = $true
} | ConvertTo-Json

Invoke-RestMethod -Method Post http://127.0.0.1:17368/screenshot `
  -ContentType "application/json" `
  -Body $body
```

### Network 和 Console

先启用 Network 或 Console 事件，再读取聚合结果。查找网络请求时，先通过筛选取得 `requestId`，再读取详情或响应体。

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:17368/network/start `
  -ContentType "application/json" `
  -Body '{}'

Invoke-RestMethod "http://127.0.0.1:17368/network?type=Fetch&method=POST&status=2xx"
Invoke-RestMethod "http://127.0.0.1:17368/network?domain=bilibili.com&url=reply"
Invoke-RestMethod "http://127.0.0.1:17368/network/detail?requestId=REQUEST_ID"
Invoke-RestMethod "http://127.0.0.1:17368/network/body?requestId=REQUEST_ID"

Invoke-RestMethod -Method Post http://127.0.0.1:17368/console/start `
  -ContentType "application/json" `
  -Body '{}'

Invoke-RestMethod http://127.0.0.1:17368/console
```

## 注意

- HTTP 服务只监听 `127.0.0.1`。
- 没有 Token、密码、调用方身份或其他鉴权层，本机任意进程都可以调用这个端口。
- 调用方可以控制标签页、执行页面 JavaScript/CDP，并读取扩展权限允许访问的浏览器数据。
- `/screenshot` 指定 `path` 时，Native Host 会使用当前 Windows 用户权限写入本地文件。
- profile 名称、备注和端口不是安全边界，只应在可信本机环境使用。
- 不能向 `chrome://`、`edge://` 等浏览器内部页面注入脚本，应使用真实网页的 `tabId`。
- `/eval fetch(...)` 等价于 F12 Console 里的 `fetch(...)`，遵守浏览器 CORS 规则。
- 终端/native HTTP 请求是另一种请求环境，不会自动等同于页面 cookie、Origin、Referer 或登录态。

## 卸载

```powershell
.\native-host\uninstall-host.ps1
```
