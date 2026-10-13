# Data Maskit (Node / Electron 版)

本地运行的大模型隐私脱敏网关：请求出网前把敏感信息替换为结构化占位符，模型回复时在本地流式还原。全部运算在本机完成，无遥测。

本项目是 [xiaYuTian11/maskit](https://github.com/xiaYuTian11/maskit)（Python + Tauri）的 Node.js 移植版，桌面端基于 [electron-egg](https://github.com/dromara/electron-egg)。

```
你的输入:  排查 mysql://root:Pass123@db:3306，联系人 13800138000
发给模型:  排查 mysql://root:{{CONNSTR_zkpmqx}}@db:3306，联系人 {{PHONE_bcdfgh}}
你看到的:  （模型回复中的占位符被还原为原文）
```

## 功能

- **18 类内置规则**：默认开启 API Key、银行卡（Luhn）、连接串密码、邮箱、身份证（校验位）、座机、手机号 7 类；私钥、JWT、Bearer Token、赋值凭据、云 AK、内网 IP、车牌、MAC、IBAN、港澳通行证等可按需开启
- **自定义敏感词**：字面量（大小写不敏感）、`re:` 正则、整词匹配；自定义词占位符跨重启稳定
- **多轮一致性**：同一原文在复用窗口内始终映射到同一占位符
- **协议感知**：只扫描业务字段，协议字段（model、role、tool_call_id 等）不改写；带签名的 thinking 块原样上行；脱敏失败直接阻断（fail-closed）
- **流式还原**：OpenAI Chat Completions / Responses、Anthropic Messages 的 SSE 逐事件还原，跨 chunk 的半截占位符自动缓冲
- **兜底直连**：关闭脱敏时端口仍监听并原样转发，工具不会断网

## 接入

把工具的 Base URL 改为本地端口：

| 协议 | Base URL |
|---|---|
| OpenAI | `http://127.0.0.1:18701/v1` |
| DeepSeek | `http://127.0.0.1:18702/v1` |
| Anthropic | `http://127.0.0.1:18703` |

端口与上游地址可在「规则」页修改。

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
electron/gateway/   多端口反向代理与配置
electron/service/   网关服务（生命周期、配置持久化）
electron/controller/ IPC 接口
frontend/           Vue 3 控制台
tests/              单元与端到端测试
```

## 许可证

[AGPL-3.0](LICENSE)。脱敏规则移植自 AGPL-3.0 的 maskit 项目；electron-egg 框架代码遵循其 [Apache-2.0](LICENSE-electron-egg) 许可证。
