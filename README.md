# Data Maskit

**在你和大模型之间加一道本地隐私闸门。** 你发给 AI 的内容里如果有密码、密钥、手机号、身份证、数据库连接串等敏感信息，Data Maskit 会在**出网前**把它们替换成占位符；AI 的回复回来时，再在**本地**把占位符换回原文。AI 服务商全程看不到真实数据，你这边的使用体验不变。

全部处理在本机完成，不上传、不联网统计。

<p align="center">
  <img src="docs/screenshots/playground.png" alt="试验台：脱敏与往返还原" width="90%" />
</p>

## 它解决什么问题

用 Claude Code、Cursor、Codex、ChatGPT 网页版这类工具时，很容易把敏感信息顺手发出去：

- 贴一段报错日志，里面带着数据库连接串和密码
- 让 AI 改配置文件，`.env` 里的 API Key 一起上传了
- 让 AI 处理客户数据，表格里有姓名、手机号、身份证
- 往网页版 AI 上传 Word / Excel，文件里有内部数据

Data Maskit 不需要你改变使用习惯：工具照常用，敏感信息自动拦在本地。

## 工作原理

```
                 ┌──────────── 你的电脑 ────────────┐
 你的工具 ──请求──▶  Data Maskit：敏感信息 → 占位符  ──▶  AI 服务商
 (Claude Code、                                       （只看到占位符）
  Cursor、网页版…) ◀──回复── Data Maskit：占位符 → 原文 ◀──
                 └──────────────────────────────────┘
```

| 环节 | 内容 |
|---|---|
| 你输入的 | `帮我排查 mysql://root:Pass123@192.168.1.50:3306/db，联系人 13800138000` |
| AI 收到的 | `帮我排查 mysql://root:{{CONNSTR_zkpmqx}}@192.168.1.50:3306/db，联系人 {{PHONE_bcdfgh}}` |
| AI 回复的 | `请检查 {{CONNSTR_zkpmqx}} 是否过期，并联系 {{PHONE_bcdfgh}} 确认权限` |
| 你看到的 | `请检查 Pass123 是否过期，并联系 13800138000 确认权限` |

占位符带类型标签（`PHONE`、`EMAIL`…），AI 能理解「这里是一个手机号」，回答质量基本不受影响；同一个值在多轮对话中始终是同一个占位符，AI 不会搞混。

## 快速开始

### 1. 安装

从 [Releases](https://github.com/wangneal369/maskit-node/releases/latest) 下载对应系统的安装包：

| 系统 | 文件 | 说明 |
|---|---|---|
| Windows | `DataMaskit-win-<版本>-x64.exe` | 若出现 SmartScreen 提示，点「更多信息 → 仍要运行」 |
| macOS（Apple 芯片） | `DataMaskit-mac-<版本>-arm64.dmg` | 安装包未签名，首次打开请右键 →「打开」，或执行 `xattr -cr /Applications/DataMaskit.app` |
| Linux | `DataMaskit-linux-<版本>-amd64.deb` | `sudo dpkg -i DataMaskit-linux-*.deb` |

### 2. 打开应用

启动后网关自动运行，在「概览」页能看到三个本地入口：

| 协议 | 本地地址（Base URL） | 默认转发到 |
|---|---|---|
| OpenAI | `http://127.0.0.1:18701/v1` | `https://api.openai.com` |
| DeepSeek | `http://127.0.0.1:18702/v1` | `https://api.deepseek.com` |
| Anthropic | `http://127.0.0.1:18703` | `https://api.anthropic.com` |

### 3. 把工具的 Base URL 改成本地地址

API Key 照常填你自己的，Data Maskit 只做转发，不保存也不替换 Key。各工具的设置方法见下一节。

### 4. 确认生效

- **试验台**页：粘贴一段文本点「脱敏」，不发任何网络请求，直接看到哪些内容会被替换、能否还原。
- **日志**页：每次真实请求一行，「脱敏数」大于 0 表示有内容被拦下，「还原」表示回复里换回了多少处。

## 接入各类工具

### Claude Code

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL="http://127.0.0.1:18703"
claude
```

```powershell
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:18703"
claude
```

用 [cc-switch](https://github.com/farion1231/cc-switch) 管理渠道的，把当前渠道的 Base URL 改成 `http://127.0.0.1:18703` 即可。

### Cursor

`Settings → Models`，打开 **Override OpenAI Base URL**，填 `http://127.0.0.1:18701/v1`，API Key 填你自己的。

### Codex 及其他命令行工具

支持 `OPENAI_BASE_URL` 环境变量的工具（Codex、Aider、OpenCode 等）：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:18701/v1"
export OPENAI_API_KEY="你的 Key"
```

DeepSeek 用 `http://127.0.0.1:18702/v1`。工具使用配置文件的，把其中的 `base_url` 改成同样的地址。

### 在代码里调用

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18701/v1", api_key="你的 Key")
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "排查连接：mysql://root:Pass123@10.0.0.8:3306/app"}],
)
print(resp.choices[0].message.content)  # 回复里的占位符已还原为原文
```

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ baseURL: 'http://127.0.0.1:18703', apiKey: '你的 Key' });
```

流式（`stream: true`）同样支持，回复逐字还原。

### 中转站 / 聚合网关（One API、New API 等）

在「规则」页的「上游」里添加一条：

| 字段 | 填写 |
|---|---|
| 名称 | 随意，如 `relay` |
| 端口 | 一个空闲端口，如 `18704` |
| 目标地址 | 中转站根地址，**不带** `/v1`，如 `https://api.your-relay.com` |
| 路径 | 需要脱敏的接口，如 `/v1/chat/completions, /v1/messages, /v1/responses` |

保存后，工具的 Base URL 填 `http://127.0.0.1:18704/v1`（Anthropic 协议的填 `http://127.0.0.1:18704`）。

### 网页版 AI（ChatGPT / Claude / DeepSeek）

网页版没法改 Base URL，需要装随附的浏览器扩展（Chrome / Edge）：

1. 应用「浏览器扩展」页：打开「启用桥接」，复制**访问令牌**
2. 点「打开扩展目录」（或从 Releases 下载 `DataMaskit-extension-*.zip` 解压）
3. 浏览器打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择上一步的目录
4. 打开扩展的「选项」页：引擎地址填 `http://127.0.0.1:5801`，粘贴访问令牌

之后在 ChatGPT / Claude / DeepSeek 网页上正常聊天即可；ChatGPT 和 Claude 上传的 Word / Excel / PPT（docx / xlsx / pptx）也会在本地脱敏后再上传。其他 AI 网站可在扩展设置中添加。

> 扩展默认在 Data Maskit 没运行时**原样放行**（不断网但不脱敏），扩展图标会变黄提示。如果你宁可请求失败也不想明文发出，在「浏览器扩展」页打开「引擎不可达时阻断」。

### 让编程助手正确使用占位符（推荐）

AI 编程助手偶尔会把占位符当成「模板变量」改写、拆开，或者替换成示例数据，导致无法还原。应用「编程助手」页提供一份行为约定（Skill），告诉助手原样使用占位符：

- **Claude Code**：点「导出 Skill 包」，解压到 `~/.claude/skills/`（页面上可一键复制安装命令）
- **Cursor / Codex / 其他**：点「复制 AGENTS.md 片段」，粘贴到项目的 `AGENTS.md` 或规则文件中

Skill 包也随 Release 发布（`maskit-placeholders-<版本>.zip`）。即使助手改写了占位符的格式（加空格、改大小写、去掉花括号、加反斜杠转义），Data Maskit 也会尽量还原。

## 会脱敏哪些内容

在「规则」页按需开关。

**默认开启**（误报低、风险高）：

| 规则 | 例子 |
|---|---|
| API Key | `sk-…`、`ghp_…`、`AIza…`、`xoxb-…` 等常见平台密钥 |
| 连接串密码 | `mysql://root:Pass123@host` 只替换 `Pass123` |
| 手机号 | `13800138000`、`+86 138-0013-8000` |
| 座机 | `010-62345678` |
| 邮箱 | `zhangsan@example.com` |
| 身份证 | 15 / 18 位，校验出生日期与校验位 |
| 银行卡 | 13–19 位，Luhn 校验 |

**按需开启**：PEM 私钥、JWT、Bearer Token、`password=` / `密码：` 这类赋值凭据、云厂商 AccessKey、内网 IP、MAC 地址、车牌、IBAN、港澳通行证。这些规则在代码和配置里误报相对多，默认关闭以免干扰 AI 理解代码。

**自定义敏感词**：公司名、项目代号、客户名等，在「规则 → 自定义敏感词」添加：

- 普通词：大小写不敏感，如 `ProjectX` 也会命中 `projectx`
- 正则：以 `re:` 开头，如 `re:PRJ-[0-9]{4}`
- 勾选「整词」：只匹配完整单词，避免 `con` 命中 `content`

**密钥前缀**：内部系统的密钥有固定前缀（如 `myco-`）时，加到「密钥前缀」列表即可。

## 安全审计与危险命令拦截

除了脱敏，Data Maskit 还会检查模型的**回复**：

- **安全审计**（默认开启，只标记不拦截）：发现回复中的提示词注入（如「忽略之前的所有指令」）、索要系统提示词、诱导把凭据发到外部地址、隐藏的零宽 / 双向控制字符，以及上游错误响应里泄露的密钥、内部路径、堆栈信息。结果在「风险」页查看。
- **危险命令拦截**：检查模型下发的工具调用参数里是否有 `rm -rf /`、`mkfs`、`format C:`、`DROP DATABASE`、`dd of=/dev/sda`、fork 炸弹等破坏性命令。三种模式：
  - **仅记录**（默认）：放行，记到「风险」页
  - **改写为提示**：把命令替换成「已拦截」说明再交给客户端
  - **阻断**：直接返回错误，命令不会到达你的工具
  可在「规则 → 危险命令拦截」关闭某条内置规则、添加自定义规则或白名单。只覆盖明文形态（写进脚本再执行、变量拼接等会漏），**这是安全网，不是保险柜**。浏览器扩展链路不做命令拦截。

## 用量统计

「用量」页按天、按模型统计请求数、输入 / 输出 / 缓存 token 和估算费用（从各家 API 返回的 usage 字段提取，覆盖 OpenAI Chat / Responses、Anthropic、DeepSeek，流式与非流式均支持）。费用按内置参考价估算，以服务商账单为准；中转站或新模型的价格可在「规则 → 模型价格」填写。

> OpenAI 流式请求只有在请求带 `stream_options: {"include_usage": true}` 时才会返回用量，否则这类请求不计 token。

## 常用设置

| 设置 | 位置 | 说明 |
|---|---|---|
| 脱敏开关 | 概览 | 关闭后网关仍在运行，请求原样转发，工具不会断网 |
| 清空映射表 | 概览 | 清除「原文 ↔ 占位符」对应关系（自定义词除外） |
| 出网代理 | 规则 → 出网代理 | 留空自动使用系统代理；填 `direct` 强制直连；也可填 `http://127.0.0.1:7890` |
| 上游与端口 | 规则 → 上游 | 修改转发目标、添加中转站、调整需要脱敏的接口路径 |
| 数据存储 | 规则 → 数据存储 | 是否持久化非凭据映射、日志保留条数 |
| 清空日志 | 日志 | 删除全部本地日志记录 |
| 危险命令拦截 | 规则 → 危险命令拦截 | 仅记录 / 改写 / 阻断；内置规则开关、自定义规则、白名单 |
| 安全审计 | 规则 → 安全审计 | 开关被动审计 |
| 模型价格 | 规则 → 模型价格 | 覆盖或补充模型单价（USD / 百万 token） |

## 注意事项

- **AI 看到的是占位符。** 如果你的问题本身依赖具体数值（比如「这个手机号是哪个运营商」），AI 无法回答，这是预期行为。
- **对应关系的保存方式**：同一个值 24 小时内（最多 2000 条）复用同一占位符。手机号、邮箱、身份证、自定义词等**非凭据**映射默认保存在本机数据库（明文，位于应用数据目录的 `maskit.db`），重启后仍能还原历史对话里的占位符；**API Key、密码、连接串、私钥等凭据只存在内存里，永不写入磁盘**，重启后对应的旧占位符无法还原。不希望落盘可在「规则 → 数据存储」关闭「持久化占位符映射」。
- **日志不含原文**：日志只记录类型标签和占位符，默认保留最近 5000 条。
- **只处理配置了路径的 JSON 请求**：图片、二进制内容、未列入「路径」的接口原样转发。
- **思考过程里会保留占位符**：Claude 的扩展思考（thinking）带有签名，改动会导致后续请求报错，因此这部分不还原。
- **扩展只覆盖已适配的网站**：DeepSeek 等站点上传的文件本体不会脱敏。
- 正则规则无法覆盖所有情况，**它是一道安全网，不是保证**。高度敏感的内容请不要发给云端模型。

## 界面

| 概览 | 日志 |
|---|---|
| ![概览：网关状态与接入地址](docs/screenshots/dashboard.png) | ![日志：每次请求的脱敏与还原统计](docs/screenshots/events.png) |
| **规则** | **浏览器扩展** |
| ![规则：内置规则开关、密钥前缀、自定义词](docs/screenshots/rules.png) | ![浏览器扩展：桥接服务与访问令牌](docs/screenshots/extension.png) |

## 从源码运行

```bash
npm install
cd frontend && npm install && cd ..
npm run dev          # 开发模式（前端热重载 + 桌面应用）
npm run typecheck    # 类型检查
npm test             # 单元与端到端测试
```

打包：先 `npm run build`，再执行 `npm run build-w`（Windows）/ `npm run build-m-arm64`（macOS）/ `npm run build-l`（Linux），产物在 `out/`。推送 `v*` 标签时 GitHub Actions 会自动构建三平台安装包并发布 Release。

```
electron/core/        脱敏与还原核心（不依赖 Electron，可单独复用）
electron/gateway/     本地网关、浏览器扩展桥接、Office 文件脱敏、配置
electron/service/     网关服务（生命周期、配置读写）
electron/controller/  界面调用接口
frontend/             控制台界面（Vue 3）
extension/            浏览器扩展（Chrome / Edge，MV3）
tests/                测试
```

## 许可证

[AGPL-3.0](LICENSE)。部分代码源自 [maskit](https://github.com/xiaYuTian11/maskit)（AGPL-3.0）与 [electron-egg](https://github.com/dromara/electron-egg)（[Apache-2.0](LICENSE-electron-egg)），按其许可证要求保留来源声明。
