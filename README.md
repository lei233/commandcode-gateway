# commandcode-gateway

基于 DSH CommandCode adapter 的独立 Chat Completions HTTP 网关。

当前处于架构讨论阶段。仓库只包含工程配置、模块占位和设计说明，尚未实现 HTTP 服务。后续功能编码由 Claude 执行。

## 已确认范围

- 面向个人本机或个人服务器使用，采用 Node.js 24 + TypeScript。
- 提供 Chat Completions JSON / SSE，支持文本、函数工具调用、工具结果回填和图片输入。
- 对外协议与鉴权参考 `MAXeaglet/commandcode-proxy`。
- 消息转换与输出处理参考本地 `cpa-commandcode-provider` Worker。
- 上游生成与模型发现统一使用 DSH CommandCode adapter。
- 辅助接口为 `/health` 和 `/v1/models`，模型使用上游原始 ID。

## 工程骨架

```text
src/
  main.ts          进程入口
  config.ts        配置解析
  server.ts        HTTP 路由与请求生命周期
  auth.ts          凭据解析
  images.ts        图片下载、校验与请求内附件
  commandcode.ts   DSH adapter 封装
  runtime.ts       DSH 依赖边界
  protocol/
    chat.ts        Chat → DSH 请求转换
    output.ts      JSON/SSE 共用的输出语义
    complete.ts    Chat JSON 输出
    sse.ts         Chat SSE 输出
docs/
  architecture.md  架构讨论稿与待定问题
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

DSH adapter 与消息层依赖沿用参考项目的锁定版本：`@mars-sea/dsh-commandcode-provider@0.17.4`、`@deepseek-ai/dsh-llm@0.2.2-rc.1`。图片处理所需的直接依赖将在架构定案后补充。

架构边界和交接状态见 [architecture.md](docs/architecture.md)。
