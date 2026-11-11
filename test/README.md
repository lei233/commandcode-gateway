# 验收范围与覆盖情况

离线测试（`npm test`，mock 上游 + 合成 `user_` 凭据）已完成以下验收；真实上游验收走 `npm run test:live`（需 `.env`，默认不执行）。

| 验收项 | 覆盖测试 |
| --- | --- |
| Chat JSON 与 SSE 文本输出、推理内容、用量及结束顺序 | `complete.test.ts`、`sse.test.ts`、`server.test.ts` |
| 凭据归一、前缀兼容、冲突和缺失 | `auth.test.ts`、`server.test.ts`（401/401 双头 400） |
| 常用参数到达 adapter 请求、不支持参数明确报错、`detail` 兼容接收不映射 | `commandcode.test.ts`（params 嵌套断言）、`chat.test.ts` |
| 工具调用 ID 保持、多调用、乱序回填、缺失/重复回填、两轮闭环 | `chat.test.ts`、`shutdown.test.ts`（两轮闭环） |
| data URL 图片、多图与文本顺序、附件校验与请求版本生成、字节进入上游请求 | `images.test.ts`、`chat.test.ts` |
| HTTP(S) 外链 400、工具结果保持文本 | `chat.test.ts` |
| 图片只在请求内存中持有（请求结束释放） | `images.test.ts`（store 作用域） |
| SSE 首帧前 JSON 错误、开流后错误帧正常关闭、失败无 `[DONE]` | `server.test.ts`、`shutdown.test.ts` |
| 开流后静默事件触发注释心跳 | `shutdown.test.ts` |
| 上游 401/403/429、超时、缺终态、半段工具参数 | `commandcode.test.ts`（映射表）、`complete.test.ts`、`sse.test.ts`、`server.test.ts` |
| 客户端断开、背压、请求体超限、服务关闭、并发隔离 | `server.test.ts`、`shutdown.test.ts` |
| 配置覆盖顺序、默认值、空闲超时映射 | `config.test.ts`、`commandcode.test.ts` |
| 模型目录缓存/过期/兜底、无 Key/关闭动态/失败路径 | `models.test.ts` |
| 健康检查不计入在途限制 | `server.test.ts` |

实现期间确认的行为修正（与架构文档原表述的差异）：

- `stop` 参数：CLI wire 格式无对应字段（adapter `UNSUPPORTED_OPTION`），网关准入时 400，不静默丢弃。
- `reasoning_effort`：任意非空字符串透传（含 `max`/`xhigh`/`off` 及未知值），仅校验类型；档位过滤由 adapter 按模型注册表（`KNOWN_EFFORTS`）处理，网关不复制该判定。
- `/provider/v1/models` 响应为 OpenAI 风格 `{object:'list', data:[...]}`；adapter 自带进程级缓存与磁盘持久化，网关层 5 分钟缓存叠加其上。
