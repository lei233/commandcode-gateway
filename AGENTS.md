# 项目交接状态

这是架构主要决策已确认的工程骨架，功能实现尚未开始。

先阅读 `README.md`、`docs/architecture.md` 和 `test/README.md`。`src/` 文件仅记录职责，当前入口只打印状态，不启动 HTTP 服务。

固定方向：仅实现 Chat Completions，支持图片输入；对外协议与鉴权参考 commandcode-proxy，上游通过 DSH CommandCode adapter；个人使用、无状态。

协议相关的请求转换、共用输出语义和 JSON/SSE 编码集中在 `src/protocol/`。

五项已确认方案以 `docs/architecture.md` 为准：请求级内存图片附件；首版支持用户消息 data URL，拒绝 HTTP(S) 外链，`detail` 兼容接收但不映射上游；SSE 延迟开流、错误帧正常关闭及事件触发心跳；内置默认值 → 配置文件 → 环境变量；全局 5 分钟模型目录缓存与固定列表兜底。

优先沿用 commandcode-proxy 已验证的行为。上游统一使用 DSH adapter，重试由 adapter 管理；图片处理只补充 DSH 附件接口必需的适配。
