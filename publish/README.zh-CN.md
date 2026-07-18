# 发布说明

这个目录负责生成发布版：把浏览器扩展和 Native Messaging 安装配置分开，最终提供一个可被本地 HTTP 端口控制的真实浏览器/profile。

项目目录：

```text
extension/      扩展目录
native-host/    native host 目录和安装脚本
README.md       开发说明
```

发布目录：

```text
publish/dist/port-tabs-v版本/
  extension/      给浏览器加载的扩展目录
  native-host/    配置 Native Messaging 和注册表的目录
  README.md
  README.zh-CN.md
  VERSION.txt
```

## 生成发布目录

在项目根目录运行：

```powershell
.\publish\build-release.ps1
```

当前会生成：

```text
publish/dist/port-tabs-v0.3.2/
```

## 发布版怎么安装

发布版安装分两步：先加载扩展，再注册 native host。假设发布目录是：

```text
publish/dist/port-tabs-v0.3.2/
```

第一步，加载扩展：

1. 打开浏览器的 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `publish/dist/port-tabs-v0.3.2/extension`。
5. 在扩展卡片上复制浏览器显示的扩展 ID。

第二步，注册 native host：

1. 打开 PowerShell。
2. 进入发布目录：

```powershell
cd D:\Users\Administrator\Desktop\renwu2\260706\publish\dist\port-tabs-v0.3.2
```

3. 使用刚才复制的扩展 ID 运行：

```powershell
.\native-host\install.ps1 -ExtensionId 你的扩展ID -Port 17368 -Browser Chrome
```

Edge 用：

```powershell
.\native-host\install.ps1 -ExtensionId 你的扩展ID -Port 17368 -Browser Edge
```

Chrome Stable/Beta/Dev/Canary 都用 `-Browser Chrome`。

安装脚本会自动生成：

```text
native-host/com.port_tabs.json
native-host/native-host.cmd
```

并写入对应浏览器的 Native Messaging 注册表项。

## 自动启动逻辑

这个项目的核心作用是把当前浏览器/profile 变成本机可调用的 HTTP 控制端口，终端或本机程序可以通过这个端口操作真实标签页、页面脚本、CDP、Network、Console 和输入调试能力。

```text
打开浏览器
  -> 扩展启动或被唤醒
  -> 扩展调用 connectNative
  -> 浏览器自动启动 native-host/native-host.cmd
  -> host.js 监听 127.0.0.1:<端口>
```

不同浏览器/profile 可以在扩展 Popup 里设置不同端口和名称。

## 模拟验证安装脚本

只验证将要写什么，不生成 `com.port_tabs.json`，不生成 `native-host.cmd`，也不写注册表：

```powershell
.\native-host\install.ps1 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -Port 17368 -Browser Chrome -DryRun
```

Dry-run 会打印：

```text
Manifest 路径
Launcher 路径
Host script 路径
Node 路径
Allowed origins
将要写入的注册表 key
```

## 卸载注册

```powershell
.\native-host\uninstall.ps1 -Browser Chrome
```

它只删除 Native Messaging 注册表项，不删除扩展目录和 native-host 文件。
