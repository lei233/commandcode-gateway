# 项目交接状态

功能实现已完成并全量离线测试通过。`POST /v1/chat/completions`（JSON/SSE、工具调用、data URL 图片）、`/v1/models`（缓存 + 兜底）、`/health` 均可用；`npm start` 监听 `config.json` 预设的 `0.0.0.0:3050`。

固定方向：仅实现 Chat Completions；对外协议与鉴权参考 commandcode-proxy，上游通过 DSH CommandCode adapter；个人使用、无状态。

协议相关的请求转换、共用输出语义和 JSON/SSE 编码集中在 `src/protocol/`。

五项已确认方案以 `docs/architecture.md` 为准。实现期间经 mock 上游实测确认的行为修正：`stop` 参数改为 400（adapter CLI wire 无 stop 字段）；`temperature`/`maxTokens` 实际进入上游 `params` 嵌套对象；`/provider/v1/models` 需 OpenAI 风格 `{object:'list', data:[...]}` 目录且 adapter 自带进程级缓存（网关层缓存叠加其上）。

上游统一使用 DSH adapter，重试由 adapter 管理。测试在 `test/`（离线 mock 上游 + 合成 `user_` 凭据）；真实上游验收走 `npm run test:live`（需 `.env`，默认不执行）。
