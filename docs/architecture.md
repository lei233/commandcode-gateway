# 架构讨论稿

状态：工程骨架已建立，功能编码尚未开始。本文中“已确认”记录用户接受的范围；“建议”与“待定”不构成最终执行规格。架构定案后再整理独立的 Execution Spec。

## 已确认

- 独立 HTTP 网关，Node.js 24 + TypeScript，单进程、无状态。
- 主要用于个人本机或个人服务器。
- 生成接口仅实现 `POST /v1/chat/completions`，包含非流式 JSON、SSE、函数工具及完整历史回填。
- 支持图片输入。用户消息中的 `image_url` 是标准接入形式，接受 base64 data URL 和 HTTP(S) URL。
- 鉴权参考 commandcode-proxy：从 `Authorization: Bearer ...` 或 `x-api-key` 提取 `user_...`，兼容 `token_user_...` 等前缀；归一后双头冲突返回 400，缺少有效凭据返回 401。
- 上游凭据只属于当前请求，交给上游校验；当前方案没有独立网关 Key、账号池或 Key 轮换功能。
- 上游生成和模型发现均经过 DSH CommandCode adapter。
- 使用上游原始模型 ID，提供 `/v1/models` 和 `/health` 辅助接口。
- `tool_choice` 首版支持 `auto` / `none`；adapter 无正式映射能力的参数明确报错，不静默丢弃。
- 后续编码由 Claude 执行；本次仅保留工程骨架。
- 协议相关的请求转换、输出语义与 JSON/SSE 编码统一放在 `src/protocol/`。

## 建议的模块边界

```text
客户端
  │
  ▼
HTTP 入口：server / auth / config
  │ 创建请求作用域（凭据、AbortSignal、附件、资源预算）
  ▼
请求转换：protocol/chat ── images
  │ DSH GenerateOptions + 请求内图片附件引用
  ▼
上游适配：commandcode ── DSH CommandCodeAdapter
  │ DSH StreamChunk
  ▼
输出语义：protocol/output
  ├─ protocol/complete → Chat Completions JSON
  └─ protocol/sse      → Chat Completions SSE
```

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 装配配置与依赖，启动及关闭服务，处理进程信号。 |
| `config.ts` | 解析和校验配置。个人使用建议默认绑定 `127.0.0.1`。 |
| `server.ts` | 路由、HTTP 校验、请求准入、请求作用域、取消传播、背压和关闭。 |
| `auth.ts` | 解析请求头并归一化当前请求的 CommandCode 凭据。 |
| `protocol/chat.ts` | 校验 Chat 字段、消息顺序、工具调用与回填，将内容转为 DSH 类型。 |
| `images.ts` | 下载或解码图片、校验和准备附件，提供 adapter 所需的附件读取接口。 |
| `commandcode.ts` | 创建请求级 adapter，注入凭据、固定上游配置、取消信号和附件服务，映射错误。 |
| `protocol/output.ts` | 统一校验输出终态、工具元数据、参数完整性与用量语义，避免 JSON/SSE 行为分叉。 |
| `protocol/complete.ts` / `protocol/sse.ts` | 分别提供 JSON 聚合与增量 SSE 编码。SSE 不保留整段文本历史。 |
| `runtime.ts` | 集中维护需要使用的 DSH 公共导出和类型。 |

`src/protocol/` 负责 Chat 协议与 DSH 类型之间的转换。HTTP 服务和鉴权、图片资源准备、adapter 调用分别保留在对应服务模块中。

## 请求生命周期

建议每个请求拥有一个独立作用域，覆盖读请求体、远程图片准备、adapter 调用以及响应写入。作用域持有一个取消信号；客户端断开、总期限到达或服务关停时，将取消传播到图片下载、上游读取和背压等待。

完整会话历史由客户端提交。网关不保存聊天记录、工具结果或客户端 API Key。图片附件是本次请求内的中间资源，响应完成或失败后释放；存储方式待定。

鉴权完成后再进行图片下载和上游调用。错误输出及日志不包含原始凭据、消息正文、图片字节或工具参数。

## 上游边界

网关只负责 Chat 与 DSH 类型之间的桥接。上游请求构造、事件解析、协议选择和重试归 adapter 管理。初始方案沿用参考 Worker 的 `protocol: 'cli'`，具体模型的内部路由仍由 adapter 决定。

`GenerateOptions` 已提供 `temperature`、`reasoningEffort`、`maxTokens` 等字段，但是否真正到达目标模型必须用 adapter 实际请求验证。当前锁定版本没有强制工具选择与 `parallel_tool_calls` 的正式输入字段。

模型目录使用 adapter 的公开模型发现接口；目录缓存范围与失败行为需要明确定义，不能让缓存结果被误认为凭据校验结果。

## 图片边界

已确认的目标是让图片字节通过 DSH attachment 接口交给 adapter，而不是把 base64 当普通文本拼进消息。

建议由 `images.ts` 处理以下工作：

- 解析 data URL，或下载 HTTP(S) 图片；远程下载不携带 CommandCode 凭据。
- 下载具有总期限、字节上限与重定向上限；解析和连接时限制本机、私网及保留地址访问。
- 校验实际栅格格式、尺寸和像素数，并按 adapter 的请求图片目标生成适用版本。
- 保持文本与图片在用户消息中的顺序，支持多张图片。
- 将请求内附件通过 adapter 的 `resolveAttachments` 接口提供；请求结束后释放。

图片编解码库、存储实现及具体限额尚未固定。`sharp` 是候选方案，当前没有加入依赖。

## 输出边界

JSON 和 SSE 共用成功、截断和失败的判定。缺少成功终态、工具参数不完整或元数据不一致时不构造正常结束。

SSE 应保持响应 ID、时间和模型一致，工具调用索引稳定，正确处理 `stream_options.include_usage`；成功时恰好发送一次 `[DONE]`。开流后的错误呈现方式仍需定案。

## 待讨论

1. 图片附件采用纯内存，还是请求级临时目录；图片库是否使用 `sharp`。
2. 图片范围是否扩展到非标准的工具结果图片；`image_url.detail` 的兼容策略。
3. SSE 开流后的失败采用错误帧并关闭，还是直接截断连接；心跳与首帧提交时机。
4. 配置采用环境变量，还是同时支持配置文件；端口、大小、超时及并发上限的具体默认值。
5. 模型目录缓存与拉取失败行为。

## 参考实现

- 本地 `/Volumes/Dev/github/cpa-commandcode-provider/worker/src/`：Chat ↔ DSH 转换、adapter 封装、JSON/SSE 和生命周期测试。
- [commandcode-proxy 源码](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs)：对外协议、凭据兼容及客户端行为参考。
- DSH 公共包 `@mars-sea/dsh-commandcode-provider@0.17.4` 与 `@deepseek-ai/dsh-llm@0.2.2-rc.1`。
