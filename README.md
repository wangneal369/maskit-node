# Data Maskit

本地运行的大模型隐私脱敏网关：请求出网前把敏感信息替换为结构化占位符，模型回复时在本地流式还原。全部运算在本机完成，无遥测。

```
你的输入:  排查 mysql://root:Pass123@db:3306，联系人 13800138000
发给模型:  排查 mysql://root:{{CONNSTR_zkpmqx}}@db:3306，联系人 {{PHONE_bcdfgh}}
你看到的:  （模型回复中的占位符被还原为原文）
```

<p align="center">
  <img src="docs/screenshots/playground.png" alt="试验台：脱敏与往返还原" width="90%" />
</p>

## 功能

- **18 类内置规则**：默认开启 API Key、银行卡（Luhn）、连接串密码、邮箱、身份证（校验位）、座机、手机号 7 类；私钥、JWT、Bearer Token、赋值凭据、云 AK、内网 IP、车牌、MAC、IBAN、港澳通行证等可按需开启
- **自定义敏感词**：字面量（大小写不敏感）、`re:` 正则、整词匹配；自定义词占位符跨重启稳定
- **多轮一致性**：同一原文在复用窗口内始终映射到同一占位符
- **协议感知**：只扫描业务字段，协议字段（model、role、tool_call_id 等）不改写；带签名的 thinking 块原样上行；脱敏失败直接阻断（fail-closed）
- **流式还原**：OpenAI Chat Completions / Responses、Anthropic Messages 的 SSE 逐事件还原，跨 chunk 的半截占位符自动缓冲
- **兜底直连**：关闭脱敏时端口仍监听并原样转发，工具不会断网

## 界面

| 概览 | 日志 |
|---|---|
| ![概览：网关状态与接入地址](docs/screenshots/dashboard.png) | ![日志：每次请求的脱敏与还原统计](docs/screenshots/events.png) |
| **规则** | **浏览器扩展** |
| ![规则：内置规则开关、密钥前缀、自定义词](docs/screenshots/rules.png) | ![浏览器扩展：桥接服务与访问令牌](docs/screenshots/extension.png) |

## 接入

把工具的 Base URL 改为本地端口：

| 协议 | Base URL |
|---|---|
| OpenAI | `http://127.0.0.1:18701/v1` |
| DeepSeek | `http://127.0.0.1:18702/v1` |
| Anthropic | `http://127.0.0.1:18703` |

端口与上游地址可在「规则」页修改。

## 浏览器扩展（网页版 AI）

ChatGPT / Claude / DeepSeek 等网页版 AI 通过随附的 Chrome / Edge 扩展接入：

1. 在应用「浏览器扩展」页开启桥接（默认监听 `127.0.0.1:5801`），复制访问令牌
2. 点击「打开扩展目录」，在 `chrome://extensions` 开启开发者模式 →「加载已解压的扩展程序」选择该目录（也可从 Release 下载 `DataMaskit-extension-*.zip` 解压后加载）
3. 在扩展「选项」页填写引擎地址与令牌

网页发出的请求在本地打码后出网，回复流式还原；ChatGPT / Claude 上传的 docx / xlsx / pptx 附件同样在本地脱敏。

## 开发

```bash
npm install
cd frontend && npm install && cd ..
npm run dev          # 前端热重载 + Electron
npm run typecheck
npm test
```

打包：`npm run build` 后执行 `npm run build-w`（Windows）/ `build-m-arm64`（macOS）/ `build-l`（Linux），产物在 `out/`。推送 `v*` 标签时 GitHub Actions 会自动构建三平台安装包并发布 Release。

## 目录

```
electron/core/      脱敏与还原核心（纯 TS，不依赖 Electron）
electron/gateway/   多端口反向代理、扩展桥接、Office 附件脱敏与配置
electron/service/   网关服务（生命周期、配置持久化）
electron/controller/ IPC 接口
frontend/           Vue 3 控制台
extension/          浏览器扩展（MV3）
tests/              单元与端到端测试
```

## 许可证

[AGPL-3.0](LICENSE)。部分代码源自 [maskit](https://github.com/xiaYuTian11/maskit)（AGPL-3.0）与 [electron-egg](https://github.com/dromara/electron-egg)（[Apache-2.0](LICENSE-electron-egg)），按其许可证要求保留来源声明。
