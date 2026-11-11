# commandcode-gateway

基于 DSH CommandCode adapter 的独立 Chat Completions HTTP 网关。

架构主要决策及五项处理方案已确认。仓库只包含工程配置、模块占位和设计说明，尚未实现 HTTP 服务。
## 已确认范围

- 面向个人本机或个人服务器使用，采用 Node.js 24 + TypeScript。
- 提供 Chat Completions JSON / SSE，支持文本、函数工具调用、文本工具结果回填和用户消息中的 data URL 图片；HTTP(S) 外链图片首版返回 400。
- 以 `MAXeaglet/commandcode-proxy` 已验证的协议、鉴权、SSE、配置及模型目录行为作为默认方案，保留 DSH 接入所需的适配。
- 消息转换与输出处理参考本地 `cpa-commandcode-provider` Worker。
- 上游生成与模型发现统一使用 DSH CommandCode adapter。
- 辅助接口为 `/health` 和 `/v1/models`，模型使用上游原始 ID。
- 图片采用请求级内存附件；`image_url.detail` 兼容接收但不映射上游。
- 配置采用内置默认值、`config.json`、环境变量依次覆盖；仓库预设监听 `0.0.0.0:3050`。
- 模型目录采用全局 5 分钟内存缓存及固定列表兜底，不承担 Key 有效性校验。

## 工程骨架

```text
src/
  main.ts          进程入口
  config.ts        配置解析
  server.ts        HTTP 路由与请求生命周期
  auth.ts          凭据解析
  images.ts        data URL 图片与请求内存附件
  commandcode.ts   DSH adapter 封装
  runtime.ts       DSH 依赖边界
  protocol/
    chat.ts        Chat → DSH 请求转换
    output.ts      JSON/SSE 共用的输出语义
    complete.ts    Chat JSON 输出
    sse.ts         Chat SSE 输出
docs/
  architecture.md  已确认的架构与处理方案
test/
  README.md        后续验收范围
```

## 开发环境

```sh
nvm use
npm ci
npm start
```

目前 `npm start` 只打印骨架状态并退出，不监听端口。`npm run typecheck` 用于类型检查；`npm test` 的入口已预留，尚无功能测试。

DSH adapter 与消息层依赖沿用参考项目的锁定版本：`@mars-sea/dsh-commandcode-provider@0.17.4`、`@deepseek-ai/dsh-llm@0.2.2-rc.1`。图片处理所需的直接依赖由 DSH 附件适配实现决定，当前不预先固定 `sharp`。

架构边界和交接状态见 [architecture.md](docs/architecture.md)。
