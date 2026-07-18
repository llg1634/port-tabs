# Port Tabs 中文说明

Port Tabs 把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

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

## 下载 Release 安装

从 GitHub Release 下载 `port-tabs-v0.3.2.zip`，解压后得到：

```text
port-tabs-v0.3.2/
  extension/      浏览器加载这个目录
  native-host/    install.ps1 写 Native Messaging manifest、cmd、注册表
  README.md
  README.zh-CN.md
  VERSION.txt
```

加载扩展：

```text
chrome://extensions -> 加载已解压的扩展程序 -> port-tabs-v0.3.2/extension/
```

注册 native host：

```powershell
cd .\port-tabs-v0.3.2
.\native-host\install.ps1 -ExtensionId 你的扩展ID -Port 17368 -Browser Chrome
```

Chrome Stable/Beta/Dev/Canary 都用 `-Browser Chrome`。Edge 用 `-Browser Edge`。

`install.ps1` 在 Release zip 解压后的 `native-host/` 里；源码仓库里的 `native-host/` 用的是开发安装脚本 `install-host.ps1`。

## 从源码运行

```powershell
.\native-host\install-host.ps1 -ExtensionId 你的扩展ID -Port 17368
```

扩展目录加载：

```text
chrome://extensions -> 加载已解压的扩展程序 -> extension/
```

## 从源码生成发布版

如果要自己生成 Release 目录：

```powershell
.\publish\build-release.ps1
```

生成结果在 `publish/dist/port-tabs-v版本/`，进入这个目录后再运行 `.\native-host\install.ps1 ...`。

## 自动启动

```text
打开浏览器
  -> 扩展启动或被唤醒
  -> 扩展 connectNative
  -> 浏览器自动启动 native-host/native-host.cmd
  -> host.js 监听 127.0.0.1:<端口>
```

如果端口没有起来，打开扩展 Popup 点 `Reconnect`，或者在 `chrome://extensions/` 刷新扩展。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:17368/health
Invoke-WebRequest http://127.0.0.1:17368/help
```

## 注意

- HTTP 服务只监听 `127.0.0.1`。
- 本机任意进程都可以调用这个端口。
- `/eval fetch(...)` 等价于 F12 Console 里的 `fetch(...)`，遵守浏览器 CORS 规则。
- 终端/native HTTP 请求是另一种请求环境，不会自动等同于页面 cookie、Origin、Referer 或登录态。
