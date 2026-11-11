# 项目交接状态

这是尚在架构讨论中的工程骨架，功能实现尚未开始。

先阅读 `README.md`、`docs/architecture.md` 和 `test/README.md`。`src/` 文件仅记录职责，当前入口只打印状态，不启动 HTTP 服务。

架构定案后将提供独立的 Execution Spec 作为后续实现依据。本文和模块占位不要求立即开始功能编码，未定事项以用户后续决策为准。

固定方向：仅实现 Chat Completions，支持图片输入；对外协议与鉴权参考 commandcode-proxy，上游通过 DSH CommandCode adapter；个人使用、无状态。

协议相关的请求转换、共用输出语义和 JSON/SSE 编码集中在 `src/protocol/`。
