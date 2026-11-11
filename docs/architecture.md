# 架构设计

状态：功能已实现，行为以代码为准；本文保留五项已确认方案的决策记录。

实现原则：对外协议以 commandcode-proxy 已验证行为为默认方案，只保留接入 DSH CommandCode adapter 必需的适配。模块边界与请求生命周期如本文所述；实现期间经 mock 上游实测确认的行为修正（如 `stop` 参数 400、`temperature`/`maxTokens` 进入上游 `params` 嵌套对象）以代码为准。

## 已确认

- 独立 HTTP 网关，Node.js 24 + TypeScript，单进程、无状态。
- 主要用于个人本机或个人服务器。
- 生成接口仅实现 `POST /v1/chat/completions`，包含非流式 JSON、SSE、函数工具及完整历史回填。
- 支持用户消息中的 base64 data URL 图片输入、文本与多图混排。首版不支持 HTTP(S) 外链图片，收到时明确返回 400。
- 鉴权参考 commandcode-proxy：从 `Authorization: Bearer ...` 或 `x-api-key` 提取 `user_...`，兼容 `token_user_...` 等前缀；生成接口归一后双头冲突返回 400，缺少有效凭据返回 401。
- 上游凭据只属于当前请求，交给上游校验；当前方案没有独立网关 Key、账号池或 Key 轮换功能。
- 上游生成和模型发现均经过 DSH CommandCode adapter。
- 使用上游原始模型 ID，提供 `/v1/models` 和 `/health` 辅助接口。
- `tool_choice` 首版支持 `auto` / `none`；adapter 无正式映射能力的生成控制参数明确报错。`image_url.detail` 作为兼容提示项接收但不映射上游，在兼容说明中明确标注。
- 协议相关的请求转换、输出语义与 JSON/SSE 编码统一放在 `src/protocol/`。

## 模块边界

```text
客户端
  │
  ▼
HTTP 入口：server / auth / config
  │ 创建请求作用域（凭据、AbortSignal、内存附件）
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
| `config.ts` | 解析和校验内置默认值、`config.json` 与环境变量，仓库预设监听 `0.0.0.0:3050`。 |
| `server.ts` | 路由、HTTP 校验、请求准入、请求作用域、取消传播、背压和关闭。 |
| `auth.ts` | 解析请求头并归一化当前请求的 CommandCode 凭据。 |
| `protocol/chat.ts` | 校验 Chat 字段、消息顺序、工具调用与回填，将内容转为 DSH 类型。 |
| `images.ts` | 解码 data URL，准备请求内存附件，提供 adapter 所需的附件读取接口。 |
| `commandcode.ts` | 创建请求级 adapter，注入凭据、固定上游配置、取消信号和附件服务，映射错误。 |
| `protocol/output.ts` | 统一校验输出终态、工具元数据、参数完整性与用量语义，避免 JSON/SSE 行为分叉。 |
| `protocol/complete.ts` / `protocol/sse.ts` | 分别提供 JSON 聚合与增量 SSE 编码。SSE 不保留整段文本历史。 |
| `runtime.ts` | 集中维护需要使用的 DSH 公共导出和类型。 |

`src/protocol/` 负责 Chat 协议与 DSH 类型之间的转换。HTTP 服务和鉴权、图片资源准备、adapter 调用分别保留在对应服务模块中。

## 请求生命周期

每个请求拥有一个独立作用域，覆盖读请求体、内存图片准备、adapter 调用以及响应写入。作用域持有一个取消信号；客户端断开或服务关停时，将取消传播到上游读取和背压等待，附件准备过程也要检查该信号。超时使用 adapter 的对应能力，网关首版不额外引入自定义的 600 秒整请求期限。

完整会话历史由客户端提交。网关不保存聊天记录、工具结果或客户端 API Key。图片附件只在本次请求内存中持有，响应完成、失败或取消后释放，不使用请求级临时目录或持久化附件仓库。

生成接口鉴权完成后再进行图片准备和上游调用。错误输出及日志不包含原始凭据、消息正文、图片字节或工具参数。

## 上游边界

网关只负责 Chat 与 DSH 类型之间的桥接。上游请求构造、事件解析、协议选择和重试归 adapter 管理。初始方案沿用参考 Worker 的 `protocol: 'cli'`，具体模型的内部路由仍由 adapter 决定。

`GenerateOptions` 已提供 `temperature`、`reasoningEffort`、`maxTokens` 等字段，但是否真正到达目标模型必须用 adapter 实际请求验证。当前锁定版本没有强制工具选择与 `parallel_tool_calls` 的正式输入字段。

模型目录使用 adapter 的公开模型发现接口，网关不另写直连上游模型目录的 HTTP 实现。目录接口使用下文的缓存与固定列表兜底策略，不承担 API Key 有效性校验。

## 已确认方案一：图片附件与处理

图片随请求进入内存，请求结束后释放。`images.ts` 将 data URL 转成 DSH 图片附件引用，通过 `resolveAttachments` 交给 adapter，避免把 base64 当普通文本拼进消息。

网关不额外设计独立的图片压缩质量、缩放尺寸、像素数、数量或字节预算策略。图片格式校验、元数据与请求版本的生成遵循 DSH 附件接口和 adapter 的图片处理目标。

图片编解码依赖只用于满足 DSH 附件接口所需的解码、校验和请求版本生成；是否需要 `sharp` 由该适配实现决定，当前不预先固定依赖。

参考：[commandcode-proxy 的用户图片转换](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs#L685)。参考项目可直接转换并透传图片，而本项目需要增加 DSH 附件引用适配。

## 已确认方案二：图片输入范围

- 用户消息支持 `image_url` 与文本混排，保留原始顺序并支持多张图片。
- 首版确定支持 base64 data URL；HTTP(S) 外链图片返回明确的 400 错误，网关不提供远程图片下载功能。
- `image_url.detail` 与参考项目一致兼容接收，不映射上游，不承诺 `low` / `high` 等值改变图片处理精度。
- Chat 工具结果保持文本。参考项目 Responses 路径中的工具截图提取、单独用户消息承载及截图裁剪预算不纳入首版。

HTTP(S) 范围的调整来自 DSH 附件接口：它需要图片字节，而参考项目只透传 URL，没有提供可直接复用的远程下载能力。

## 已确认方案三：JSON 与 SSE 输出

JSON 和 SSE 共用成功、截断和失败的判定。缺少成功终态、工具参数不完整或元数据不一致时不构造正常结束。

SSE 保持响应 ID、时间和模型一致，工具调用索引稳定，正确处理 `stream_options.include_usage`。首个可输出事件到达后才提交 HTTP 200；此前发生的错误仍返回 JSON 错误与相应 HTTP 状态。

开流后发生错误，发送 `data: {"error": ...}` 错误帧并使用正常响应关闭，使缓冲中的错误帧能够送达；失败路径不追加成功终态或 `[DONE]`，成功时恰好发送一次 `[DONE]`。客户端已经断开或连接不可写时只清理资源。

心跳沿用参考项目 Chat 路径的触发方式：已开流后，收到上游数据但未产生可见输出时发送 `: keepalive` 注释心跳。本项目以 adapter 交付的 DSH `StreamChunk` 为触发依据，不绕过 adapter 解析原始流。网关不额外增加固定间隔的心跳定时器；adapter 完全静默时不会由此机制产生心跳。

背压时等待下游可写，同时监听连接关闭和错误。可选的背压等待超时默认关闭。上游重试交给 DSH adapter，网关不再叠加一层重试。

参考：[commandcode-proxy 的 Chat 流处理](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs#L1661)。

## 已确认方案四：配置与默认值

配置优先级为：内置默认值 → `config.json` → 环境变量。资源限制沿用参考项目的环境变量配置方式。

| 配置 | 默认值与规则 |
| --- | --- |
| 监听地址 | 内置 `0.0.0.0:3000`，仓库 `config.json` 预设 `0.0.0.0:3050`；`HOST` / `PORT` 可覆盖。 |
| 请求体上限 | `CC_MAX_BODY_MB=100`，即 100 MiB，超限返回 413。 |
| 流式读取空闲超时 | `CC_STREAM_IDLE_MS=30000`，即 30 秒。 |
| 非流式读取空闲超时 | `CC_NONSTREAM_IDLE_MS=90000`，即 90 秒。 |
| 在途请求上限 | `CC_MAX_INFLIGHT=0`，默认不限制；启用后超限返回 503 与 `Retry-After`，健康检查不计入。 |
| 下游背压等待超时 | `CC_CLIENT_DRAIN_TIMEOUT_MS=0`，默认关闭。 |
| HTTP keep-alive | `CC_KEEPALIVE_TIMEOUT_MS=65000`，即 65 秒。 |
| 动态模型目录 | `useProviderModels=true`，可通过 `CC_USE_PROVIDER_MODELS=false` 关闭。 |
| 模型目录缓存 | `modelRefreshIntervalMs=300000`，即 5 分钟。 |

生成请求的空闲超时根据 `stream` 选择对应配置并映射到 DSH adapter 的能力，不复制参考项目的上游传输实现，也不重置为整个请求的总期限。其他连接及上游处理行为沿用 adapter。

参考：[配置加载](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs#L18) · [资源限制默认值](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs#L242)。

## 已确认方案五：模型目录缓存与兜底

沿用参考项目的全局内存缓存，默认有效期 5 分钟，不按 API Key 隔离。缓存内容为模型目录元数据，不保存原始 Key 或持有请求凭据的 adapter 实例。

未命中有效缓存时，通过当前请求的 adapter 调用 `listModels()`。获得有效非空目录后转换为对外模型列表并缓存；adapter 不可用、调用失败或未返回可用目录时，返回本地固定模型列表。没有 Key 或关闭动态发现时也可使用固定目录；已有有效全局缓存时可直接使用缓存。

固定兜底目录参考锁定版本 commandcode-proxy 的内置模型列表。固定列表只服务模型展示，不控制生成请求的可用模型。网关不增加“过期目录最多继续使用 30 分钟”的策略，也不将兜底结果当成一次动态刷新成功。

`/v1/models` 按参考行为返回 200 和可用目录，不承担 Key 有效性校验。生成请求直接将上游原始模型 ID 交给 adapter，不以目录命中为前提，模型目录拉取失败不阻断生成。

参考：[commandcode-proxy 的模型发现与缓存](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs#L2924)。

## 参考实现

- 本地 `/Volumes/Dev/github/cpa-commandcode-provider/worker/src/`：Chat ↔ DSH 转换、adapter 封装、JSON/SSE 和生命周期测试。
- [commandcode-proxy 源码](https://github.com/MAXeaglet/commandcode-proxy/blob/972828aff37f07c9cb12959bc6a1f4d44aaa005a/proxy.mjs)：对外协议、凭据兼容及客户端行为参考。
- DSH 公共包 `@mars-sea/dsh-commandcode-provider@0.17.4` 与 `@deepseek-ai/dsh-llm@0.2.2-rc.1`。
