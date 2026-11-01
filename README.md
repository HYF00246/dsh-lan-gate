# dsh-lan-gate

> 手机连上电脑的移动热点，浏览器打开 `http://192.168.137.1:18080`，直接操控电脑上的 **DeepSeek Harness**。
> 不用装 App、不走公网、不需要二维码或密码。

DSH 界面右下角有一个悬浮开关：**需要时点开，不用时点掉**。关掉后端口立即释放，局域网里谁也连不进来。

> ✅ **状态：P1 已完成并在真机验证。** 手机经热点访问、操控 DSH 已实测通过（HTTP + WebSocket）。

---

## 特性

- 📱 **免装 App**：手机浏览器直接用，可以「添加到主屏幕」
- 🖥 **完整操控**：看流式输出、点审批、回答提问、发指令、切会话——不是只读镜像
- 🔌 **用完即关**：界面右下角悬浮开关，关闭后不监听任何端口
- 🛡 **不暴露公网**：只绑定热点网卡的地址，家里 Wi-Fi、公司网络、公网都碰不到
- 🔁 **随 DSH 启停**：插件加载即注册，DSH 退出即释放端口，无残留

## 不做什么

- ❌ 公网访问 / 隧道 / 域名 / HTTPS 公共证书
- ❌ 多用户、账号体系
- ❌ 原生 iOS / Android App
- ❌ 登录页、二维码、密码（见[安全说明](#安全说明)）

---

## 工作原理

```
手机浏览器 ──HTTP / WebSocket──▶ 192.168.137.1:18080
                                      │  插件自带的代理
                                      │  改写 Host / Origin，代持一份合法 Cookie
                                      ▼
                                127.0.0.1:54362
                                DSH 自带 web server（鉴权照常生效）
```

几个关键点：

1. DSH 的 web 服务只监听 loopback，并且有认证（每进程随机 token → 签名 Cookie）。
   所以**简单的端口转发是行不通的**，裸转发只会拿到 `401 dsh web authentication required`。
2. 插件跑在 DSH 进程内，可以用官方 API 换到那份 Cookie，替手机「代持」——**没有绕过或关闭 DSH 的任何校验**。
3. 前端不写死地址（`<base href="./">` + 相对 WebSocket），所以手机经代理访问时，所有资源自然指向热点地址。
4. WebSocket 只有一条（`/api/remote.mux`），代理做双向透传；不设任何空闲超时，否则会打断流式输出。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 11（移动热点基于 Wi-Fi Direct） |
| DSH | 桌面版，0.2.1-rc.5 |
| Node | ≥ 22（DSH 自带运行时即可） |
| 网络 | 电脑开启「移动热点」，手机连上该热点 |

热点网络参数（Windows ICS 默认，实测稳定）：

| 项目 | 值 |
|---|---|
| 电脑侧地址 / 手机网关 | `192.168.137.1` |
| 子网 | `192.168.137.0/24` |
| 手机获得的地址 | `192.168.137.x` |

> 电脑在保持原有 Wi-Fi 的同时开热点，两者互不影响。

---

## 安装

### 1. 放行防火墙（管理员 PowerShell，只需一次）

Windows 防火墙默认拦截入站，手机访问会表现为**超时**（Chrome `ERR_TIMED_OUT` / -7）。
只放行热点网段即可，不需要关防火墙：

```powershell
New-NetFirewallRule -DisplayName "DSH LAN gate" -Direction Inbound -Protocol TCP `
  -LocalPort 18080 -RemoteAddress 192.168.137.0/24 -Action Allow
```

⚠️ **关键坑：如果 DSH 曾被你拒绝过联网**（首次监听时弹窗里点了「取消」），Windows 会给
`DeepSeek Harness.exe` 记一条**入站 Block 规则**。Block 的优先级高于端口放行规则，此时上面的
端口规则形同虚设，手机依旧超时。先检查并删掉它：

```powershell
# 自动取 DSH 进程的可执行文件路径
$exe = (Get-Process 'DeepSeek Harness' | Select-Object -First 1).Path
Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue |
  ForEach-Object { Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $_ } |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |
  Remove-NetFirewallRule
```

删 Block 只影响"外网连入 DSH"，不影响 DSH 出站（调模型、更新都不受影响）。

卸载时删除：

```powershell
Remove-NetFirewallRule -DisplayName "DSH LAN gate"
```

### 2. 安装插件

**完全退出** DeepSeek Harness（关窗口只是最小化到托盘，要走「退出」），然后：

```powershell
# 用 DSH 安装目录自带的 CLI 安装本地插件
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add link:<本仓库绝对路径>
```

给别人装（从 GitHub 直接装，不需要 npm 账号）：

```powershell
dsh plugin --profile desktop add github:HYF00246/dsh-lan-gate
```

> npm 上的 `dsh-lan-gate` 这个名字已被他人占用，本项目的 npm 包名会改用
> `dsh-lan-gate-hotspot`（尚未发布）。发布后即可 `dsh plugin --profile desktop add dsh-lan-gate-hotspot`。

安装命令会自动把插件登记到 profile 的 `dsh.profile.bundles`。

### 3. 启动 DSH

界面右下角会出现「局域网访问」悬浮开关，默认是**关**。

---

## 使用

1. 电脑开热点，手机连上（提示「此 WLAN 无法访问互联网」时选**保持连接**）
2. 点 DSH 右下角的开关 → 变成绿色「开」
3. 手机浏览器打开 `http://192.168.137.1:18080`
4. 用完再点一下关掉

按钮说明：

- **单击**切换开关；**长按 450ms** 可以拖动位置（位置会记住，开关状态每次启动都重置为关）
- 胶囊宽度固定，不会因为开关状态变长：灰色「关」/ 绿色「开」；鼠标悬停可看到当前访问地址
- 位置按「距右下角的距离」记录，窗口缩放、进出全屏都不会错位
- 手机等窄屏（宽度 < 820px）**自动隐藏**，避免挡住发送/确认按钮——开关在电脑上点
- 失败时变红显示「失败」，悬停可看到原因（如「热点未开启」）

---

## 安全说明

⚠️ **这个插件按设计不设登录**：同一热点下的**任何设备**都能打开并操控这台电脑——
包括执行命令、读写文件。请只在你能控制热点内设备时使用，用完点掉开关。

已经做到的保护：

- 只监听 `192.168.137.1`（热点网卡），不监听 `0.0.0.0`，其他网络接口完全无感知
- 关闭开关后不监听任何端口
- DSH 自身的浏览器鉴权完全保留（插件只是代持 Cookie，不是绕过）
- 代理层做了路径白名单，`/connect`（会签发 API 凭据）被显式拒绝

想加密码/设备白名单，可以在本插件前叠一层认证，不需要改架构。

---

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 手机打开超时（`ERR_TIMED_OUT`） | 防火墙没放行 → 做[第 1 步](#1-放行防火墙管理员-powershell只需一次)；或热点没开 |
| 手机超时，但本机 `curl http://192.168.137.1:18080` 正常 | **DSH 被防火墙 Block 了**：查并删除针对 `DeepSeek Harness.exe` 的入站 Block 规则（见第 1 步的警告） |
| 手机打开「连接被拒绝」 | 到电脑了但端口没监听 → 开关是不是没点开？ |
| 按钮一直显示「热点未开启」 | 先开电脑的移动热点，再点开关 |
| 按钮根本不出现 | 插件没装上 / 装完没重启 DSH（注入表是启动时快照）；看 DSH 日志 |
| 手机提示「此 WLAN 无法访问互联网」 | 选「保持连接」，不影响本地访问 |
| iPhone 连上后自动切回蜂窝 | 关闭「无线局域网助理」，或在热点里开启「共享我的 Internet 连接」 |
| 电脑睡眠/重启后热点关闭 | 重新打开热点，再点一次开关 |
| 手机上页面能开但没数据/一直重连 | 检查网络是否被其他代理/防火墙中间件拦截 |

---

## 开发

```
.
├─ package.json        # 插件元数据（dsh.bundle.patch 指向下面的 patch）
├─ cordis.patch.yml    # 把插件行插入 DSH 配置树
├─ lib/                # 插件实现（ESM，无构建步骤、零运行时依赖）
│  ├─ index.js         #   入口：注入按钮 → 注册路由 → 生命周期
│  ├─ gate.js          #   开关状态机与监听
│  ├─ proxy.js         #   HTTP / WebSocket 反向代理
│  ├─ auth.js          #   启动 token → 签名 Cookie 的获取与续期
│  └─ routes.js        #   /__lan_gate/* 三个精确路由
├─ assets/
│  └─ widget.js        # 悬浮开关（原生 JS，无框架）
└─ test/               # node --test
```

本地开发要点：

- 插件用 `link:` 方式安装，desktop host 默认开 HMR，改代码一般会在重组合时热替换
- 但**注入表是宿主启动时的快照**，改按钮相关代码需要重启 DSH
- 上游地址不要写死：用 `ctx.webServer.getOrigin()`，并在端口绑定前做好重试

跑测试：

```powershell
node --test
```

## 许可

[MIT](LICENSE)
