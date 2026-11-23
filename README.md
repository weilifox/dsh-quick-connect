# dsh-quick-connect

把 **Amazon Quick**（AWS 的 AI 助手桌面客户端）的聊天时长接进 DeepSeek Harness（DSH）——在 DSH 里选 Quick 的档位模型聊天，消耗 Quick 账号的免费/订阅时长，而不是 token。

- 版本：0.3.1
- 仓库：https://github.com/weilifox/dsh-quick-connect
- 前置：本机装过 Amazon Quick 桌面端（默认在 `%LOCALAPPDATA%\Programs\quickwork`）并登录过一次；凭据留在 Windows 凭据管理器里，本插件**只读**

![DSH 模型选择器里的 Amazon Quick 分组](assets/screenshot-1.png)

## 档位（= 三/四档消耗规则）

| 模型 id | Quick `agent_mode` | 定位 | 实测路由 |
|---|---|---|---|
| `fast` | fast | 最省时长，日常问答 | `us.anthropic.claude-haiku-5-5` |
| `balanced` | balanced | 均衡 | 待实测 |
| `smart` | smart | 默认推荐 | 待实测 |
| `advanced` | advanced | 最强，烧时长最快 | 待实测 |

档位随每条消息发送，云端按档自动路由底层模型；DSH 侧选哪个 id 就发哪个 `agent_mode`。

## 本机工具（v0.2.0 新增，v0.2.1 稳定）

Quick 的云端 agent 除了 Amazon 侧工具，还能调用**本机工具**——这就是 Quick 桌面端「Outpost」通道。插件现在把它接上了：

1. 插件按需拉起 Quick 自带的 `quickwork-agent.exe --outpost-only`（同一个二进制，独立端口，不启动 Quick 界面）；
2. 用一次性的 instance token（`crypto.randomBytes(32)`，只经 stdin 下发、不落盘）调它的本地 HTTP API；
3. 聊天时在 `user_message` 里带上 `outpostId` 等设备字段，云端就把这一轮认作「来自用户设备」，工具调用通过 WSS 以 `tool_call` 帧下发，插件转给本机 outpost 执行，再用 `tool_result` 帧回传。

实测可用：本机 Python（`run_python_outpost_local` / `_with_write`）、文件读（云端发 `file_upload`，outpost 自己传到 S3 后云端再读）、文件写（云端发 `file_download` 下发 staged 产物）、`ripgrep`/`fdfind`/`folder_list` 等 47 个工具。

**文件访问白名单**：Quick 的 outpost 只允许访问登记过的目录（`/local/allowed_folders`）。插件启动后按设置项 `allowedFolders`（换行或 `;` 分隔）逐个登记；留空则默认登记 DSH 宿主的工作目录。未登记的路径会返回 `Access denied. Path is not in allowed folders: []`。

**安全边界**：本机工具由 Quick 自己的 outpost 执行、走它自己的策略（`human_pps_grant` 审批来源），插件不额外放大权限；关掉开关（设置项 `localTools = false`）即完全不拉 outpost，行为回到 0.1.1 的纯聊天。

## 0.3.1 修的是什么

0.3.0 在真机上露了两个尾巴，都不是协议设计的问题，是模型写出来的字面量不合 JSON：

- **请求被当成正文发出来**。Quick 写 PowerShell 命令时把引号直接塞进字符串（`"command":"… -Command "Get-ChildItem 'D:\x'"`），`JSON.parse` 一律拒收，请求就漏成了聊天文字。0.3.1 加了一个容错扫描器：读字符串时只要后面不是 `,`/`}` 就当它是命令里的引号而不是结束符，Windows 反斜杠原样保留；也支持「先一句话、再一行请求」。
- **工具清单被截断**。DSH 真机 94 个工具，旧版按 64 条 + 字节不可控的中文描述拼，正好把 `ops_bash` 这种后排工具挤掉，模型只好猜名字（猜成 `pwsh`）。0.3.1 改成按**字节**算预算（≤11 KB）、描述分三档降级（完整 → 26 字 → 只留名字），并给 `pwsh`/`powershell`/`cmd`/`sh` 加了别名。

同一版还修了本机工具通道的三处（回归测试时定位到）：

- **设备调用参数多包了一层**。新版云端发的 `tool_call` 里，真实工具名与参数在 `payload.arguments.params` 下面（`{params:{name,arguments}, _quickwork:{…}}`），旧版把整个壳交给 outpost，等于空参执行，回一个 traceback。
- **`permission_request` 没人应答**。写类设备工具要先授权，桌面端点「允许」时回 `tool_approval {connectorId, actionId, scope}`；插件以前不回，云端等不到就关流，表现为回复说到一半断掉。现在按 `ALLOW_ALWAYS` 自动应答。
- **失败被当成成功**。outpost 的 `/local/invoke_tool` 对执行失败仍回 HTTP 200，错误体只有 `error` 字段（既没有 `success:false` 也没有 `status:"error"`），旧版因此把 traceback 当结果回给云端。判定已补上这一条。

**已知问题**：本机工具这一路偶发「tool_result 之后云端关流」（回复被截断，重试后通常能走通）。DSH↔Quick 的**工具桥**不受影响，是这个版本的主通路。

## 让 Quick 调用 DSH 的工具（v0.3.0 新增）

Quick 的双向流只收**聊天文本**，DSH 的工具定义发不过去——没有工具，模型每次回一句就结束一轮，看起来就是「每一步都停下来问一句」。v0.3.0 用一个**文本协议**把这个环补上：

1. 发消息前，插件把 DSH 当前可用的工具清单压成紧凑列表（最多 28 条，名称 + 一句描述 + 参数名/类型），连同协议说明放在 prompt 开头；
2. 模型需要动手时回一行 JSON 执行请求：

   ```json
   {"tool":"ops_bash","arguments":{"command":"ls"}}
   ```

3. 插件把它解析成 pi-ai 的 `toolCall` 块、`stopReason` 置为 `toolUse`，DSH 照常执行工具（走 DSH 自己的审批与沙箱）；
4. 工具结果作为下一条消息以 `[工具 name 的结果]` 回到 Quick，模型据此继续——这就是正常的 agent 循环。

**协议为什么长这样**：一开始用的是 `<tool_call>{…}</tool_call>` 标签，实测被 Quick 内核一律拒绝（模型坚持「我没有这个工具」），三种措辞 × 两档都一样。换成「你有一个外部执行器 DSH + 一行 JSON 执行请求」后 3/3 通过，包括 `smart` 档；所以协议是 JSON 请求，不是伪造标签。

**工具清单从哪来**：pi-ai 在把请求交给 provider 之前会走 `normalizeContext()`，把 `context.tools` 折进一条 `role: "system"` 的首条消息（字段 `toolsAdded` / `toolsRemoved`），provider 收到的是纯 messages。所以插件按 pi-ai 自己的 `getCurrentTools()` 语义回读这段 transcript 才能拿到工具（只读 `context.tools` 会一直是空的，实测就卡在这里）。

**工具名容错**：Quick 偶尔会把工具名写成大白话（`bash`、`shell`、`read_file`），DSH 会直接回 `unknown tool`。插件现在先按声明名精确匹配，再按后缀/同义词表兜底（`bash`/`shell`/`exec` → 声明的 `*_bash`，`read_file` → `*_read`…），名字实在对不上才原样交给 DSH。清单上限也从 28 提到 64 条（DSH 一套工具通常 90+ 个，只列 28 条会让 `ops_bash` 这种后排工具根本不出现）。

**解析规则**：整段回复是一个 JSON 请求（或包在 ```json 围栏里）才视为调用；模型在解释里引用的 JSON 片段不会被误当成调用（JSON 后面还有超过 120 字符的正文即判为例句）。`<tool_call>` 标签作为兼容写法仍然接受。

**两条通道互斥（实测）**：只要本轮带了 DSH 的工具清单，插件就**不再声明本轮来自本机设备**。原因很直接——一旦云端把这轮认作「设备轮次」，它会优先用自带的本机工具（`run_python_outpost_local`、`file_read` …）干活，根本不看 JSON 协议；实测「列出最新 5 个文件夹」就是被 outpost python 拦走的，`ops_bash` 一次没调。所以桥接开启时设备工具让位，桥接关闭时才轮到它。

**关闭方式**：设置项 `toolBridge = false`（或 DSH 侧本轮不提供工具），插件就不发协议段，退化成纯聊天——此时本轮重新按设备轮次发出，Quick 用它自己的本机工具干活（见上一节），只是 DSH 的工具循环不参与。

## 用量显示

设置 → 插件 → Amazon Quick 卡片展开后显示：

- 本次会话用量（分钟 / 上限，进度条）
- 本月用量（分钟 / 上限，进度条）
- 订阅状态（如 `QUICK_LITE_FREE_TRIAL（免费试用，2026-12-21 到期）`）

数据来自 Quick 自己的 `/profile/usage`，只读。

## 工作原理（三条通路，全部实测）

1. **凭据**：Windows 凭据管理器 `quickwork-social-<profileId>`（+`_chunk_N`）→ CredRead 读出 `refresh_token/client_id/client_secret`；profile 元数据来自 `~/.quickwork/profiles.json`。**全程只读，不写回**。
2. **续票**：`POST https://oidc.us-east-1.amazonaws.com/token`（grantType `refresh_token`）换 1h accessToken。标准 AWS SSO OIDC API，无需启动 Quick 客户端。换出的新 refresh_token 只存内存。
3. **聊天**：`wss://{tenant}/streaming/quickwork-chat-bidirectional-stream?surfaceType=QUICK_WORK_DESKTOP_WINDOWS&token=…&workingSessionId=…`
   - 出站帧：binary JSON `{eventType:"rawInputEvent",payload:{payload:base64(内部JSON)}}`
   - 入站帧：AWS event-stream 头 + JSON `{"payload":base64(内部JSON)}`（尾部带 CRC，需容忍尾随字节）
   - 直接发 `user_message`（URL 的 workingSessionId 即会话，`session_connect` 会被拒 unknown_message_type）
   - 收 `text_delta…text_complete/message_complete` 组装答案，`turn_usage` 回填 token 用量，`resolved_model_id` 记录实际路由模型

**代理**：tenant 域名（`*.dp.appintegrations.*.plato.ai.aws.dev`）不在公共 DNS。插件启动时探测本机代理（`127.0.0.1:7897/7890/10809/8888`，可用 `QUICK_CONNECT_PROXY` 环境变量或设置里的代理项指定），走 HTTP CONNECT 隧道发 HTTPS/WSS。

## 安装

前提：DSH 桌面版（profile 目录 `~/.dsh/profiles/desktop`，下称 `<profile>`），并把本仓库克隆到任意位置（下称 `<插件目录>`）。

1. 登记成 profile 依赖（推荐 link，便于改代码即生效）：
   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm add "link:<插件目录>" --config.minimum-release-age=0
   ```
2. 让 DSH 加载这个 bundle：在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组里追加 `"dsh-quick-connect"`。
3. 插件目录里的 `node_modules` 需要能解析宿主依赖（`@deepseek-ai/*`、`@earendil-works/pi-ai`）。用 pnpm 装依赖，或直接指向 DSH 自带的 `node_modules`：
   ```bash
   cd <插件目录>
   ln -s "<DSH安装目录>/resources/app/dsh/node_modules" node_modules   # Windows 用 mklink /J 或 New-Item -ItemType Junction
   ```
4. 重启 DSH，在「设置 → 插件 → Amazon Quick」里应当看到登录态与用量条。

卸载：从 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉本插件，重装依赖，重启 DSH。

## 状态路由

```bash
curl http://127.0.0.1:<DSH端口>/plugins/dsh-quick-connect/status   # 状态+用量
curl -X POST http://127.0.0.1:<DSH端口>/plugins/dsh-quick-connect/action \
  -H 'content-type: application/json' -d '{"action":"refresh"}'    # 强制刷新
```

## 自检

```bash
cd dsh-quick-connect && node scripts/selfcheck.mjs    # 离线自检
node scripts/verify-live.mjs                          # 真网链路（会真发一条 pong）
node scripts/verify-live.mjs --mode=balanced          # 指定档位实测路由模型
node scripts/verify-localtools.mjs                    # 本机工具（拉 outpost + 两轮真调用）
node scripts/verify-toolbridge.mjs   # + verify-toolbridge-shape.mjs（transcript 形态）                    # 工具桥（两轮：模型要工具 → 喂回结果 → 出答案）
QUICK_DEBUG_EVENTS=1 node scripts/verify-localtools.mjs   # 打协议帧，排障用
```

## 已知限制

- **宿主 system prompt 被塌缩**：DSH 的 project_instructions（含 25 条 Scoped Rules）会触发 Quick 的内容审核（USER_QUERY/BUILT_IN），逐轮必拦。插件现在对 Quick 通路**不发送宿主原版 system prompt**，只发一条中性任务前言 + 你的消息 + 会话历史。Quick 反正不认外来 persona，不影响回答质量。
- **本地工具只经 Quick 的 outpost**：文件/Python 都在 `quickwork-agent.exe` 里执行，受它的目录白名单约束；DSH 自己的工具（ops_bash 等）不会被 Quick 调用，两套工具面是分开的。
- 不带图片输入（Quick 桌面端协议的图片通路未逆向）。
- Quick 客户端退出登录 / 换号后，插件凭据会失效——重新在 Quick 登录一次即可，无需动插件。
- 协议是私有的，Amazon 改协议/风控会导致失效；`turn_usage.resolved_model_id` 可用于判断档位是否被服务端调整。

## 排障

| 现象 | 原因 → 处理 |
|---|---|
| 设置卡「未登录」 | Quick 没登录过 / profiles.json 缺失 → 打开 Quick 登录一次 |
| OIDC refresh failed 400/403 | refresh_token 被 Quick 侧轮换 → 状态卡点「刷新用量」重读凭据 |
| `fetch failed` / handshake 失败 | 本机代理没开 → 启动 Clash 类代理，或设置里指定代理 |
| `Unsupported surface type` | 协议常量变了 → 重新逆向 surfaceType |
| 能聊但答案怪 | 检查 `turn_usage.resolved_model_id` 是否符合预期档位 |
| 答到一半突然断流 | 客户端每 25s 要发 `ping` 保活（已实现）；本机工具耗时过长时服务端会先关流，重试即可 |
| 设备工具报 `Path is not in allowed folders` | 目标路径不在 `allowedFolders` → 设置里加一行该目录 |
| 模型说「我没有 ops_bash 这个工具」 | 走的是 v0.2.x 的纯聊天通路 → 升级到 0.3.0 并确认 `toolBridge` 为开 |
| 回复里直接出现 `{"tool":"…","arguments":{…}}` 原文 | 0.3.1 起容忍这种写法：命令里的引号没转义、Windows 反斜杠原样写都能读出来；若仍出现，说明请求后面还跟着大段说明（>120 字符），把它单独发一行 |
| 模型抱怨「工具列表被截断，看不到完整名称」 | 0.3.1 把清单预算按字节算（≤11 KB）并优先保留全部名字，94 个工具也能列全；仍嫌长就把不需要的插件关掉 |
| `本机工具通道未启用` | 设置项 `localTools` 被关，或 outpost 起不来 → 看状态卡 `localTools.error` / 手动 `outpost-restart` |
