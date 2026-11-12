# commandcode-gateway

[English](README.md) | **简体中文**

基于 DSH CommandCode adapter 的独立 Chat Completions HTTP 网关。

功能实现已完成：`POST /v1/chat/completions`（JSON/SSE、函数工具调用、data URL 图片）、`/v1/models`（5 分钟缓存 + 固定兜底）与 `/health` 均已可用（2026-11 审查修订：优雅关停连接清理、上游 404 透传、SSE 空流补 role 首帧、图片限额按请求口径）。

## 已确认范围

- 面向个人本机或个人服务器使用，采用 Node.js 24 + TypeScript。
- 提供 Chat Completions JSON / SSE，支持文本、函数工具调用、文本工具结果回填和用户消息中的 data URL 图片；HTTP(S) 外链图片返回 400。
- 对外协议与鉴权参考 `MAXeaglet/commandcode-proxy`；上游生成与模型发现统一经 DSH CommandCode adapter（`protocol: 'cli'`）。
- 消息转换与输出处理参考本地 `cpa-commandcode-provider` Worker。
- 鉴权：`Authorization: Bearer ...` / `x-api-key` 提取 `user_...`（`token_user_` 等前缀兼容）；归一后双头冲突 400，缺失 401。凭据每请求透传，网关不持有 Key。
- 支持的生成参数：`temperature`（任意有限数字透传，范围由上游判定）、`max_tokens`/`max_completion_tokens`、`reasoning_effort`（任意非空字符串透传，档位是否生效由 adapter 按模型注册表过滤）、`tool_choice`（auto/none）；`store:false`、`user`、`metadata` 静默接受（无状态网关，不承诺存储/审计行为）；`stop` 与其余无映射能力的参数明确 400（CLI wire 格式无对应字段，上游 adapter 亦显式拒绝 stop）。工具调用 id 不设长度上限，超长 id 由 adapter 重映射为短别名。
- 图片采用请求级内存附件（sharp 解码校验 + 长边 1568/1MiB 请求版本重编码）；准入限额对齐 adapter 实际请求预算（每请求 60 张 / 聚合原始字节 64MiB、单张 10MiB）；`image_url.detail` 兼容接收但不映射上游。
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

`npm start` 监听 `config.json` 预设的 `0.0.0.0:3050`（`HOST`/`PORT` 可覆盖）。`npm run typecheck` 类型检查；`npm test` 运行离线测试（mock 上游 + 合成凭据）；`npm run test:live` 对真实上游验收（需 `.env` 提供 `COMMANDCODE_API_KEY`，默认不执行）。

图片处理依赖 `sharp`（请求版本重编码）。DSH adapter 与消息层依赖沿用参考项目的锁定版本：`@mars-sea/dsh-commandcode-provider@0.17.4`、`@deepseek-ai/dsh-llm@0.2.2-rc.1`。

架构边界和交接状态见 [architecture.md](docs/architecture.md)。

## VPS 部署（Docker）

前置：Docker Engine（含 compose 插件）。构建在 VPS 上完成，无需镜像仓库。

```sh
git clone <repo-url> && cd commandcode-gateway
docker compose up -d --build
curl -s http://127.0.0.1:3050/health   # {"status":"ok"}
```

- 镜像为多阶段构建：测试阶段跑 `typecheck` + 全量离线测试（进程内 mock 上游，不需要网络与真实凭据），通过才进入运行阶段；运行阶段以非 root 用户仅装生产依赖。
- 基础镜像默认 `node:24-alpine`；若镜像源受限或已有预拉取镜像，可 `docker build --build-arg NODE_IMAGE=node:24.x-bookworm-slim ...` 覆盖（glibc 变体的 sharp 二进制同样在 lockfile 内）。
- 容器只绑 `127.0.0.1:3050`，不对公网暴露，由宿主机既有反代转发；网关自身零凭据（Key 逐请求透传），无需注入任何 secret。
- `docker stop` 发出的 SIGTERM 走内建优雅关停（5s drain 后退出）；重启策略 `unless-stopped`。

### 对接反代

- SSE 流式转发需关闭缓冲：nginx 设 `proxy_buffering off`；Caddy 反代默认即流式，必要时 `flush_interval -1`。
- 读超时建议 ≥ 300s，覆盖流式空闲上限（`CC_STREAM_IDLE_MS` 默认 30s，上游长回复期间由心跳帧保活）。
- 若反代本身是 Docker 容器：去掉 `ports`，改为共享 Docker 网络按服务名 `commandcode-gateway:3050` 访问。

### 运维

- 更新：`git pull && docker compose up -d --build`（旧容器优雅替换）。
- 日志：`docker compose logs -f`。
- 调优：在 `compose.yaml` 的 `environment` 覆盖 `CC_*` 变量（完整清单见 [architecture.md](docs/architecture.md) 方案四）；`HOST`/`PORT` 同样可覆盖。

## 致谢

- [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) —— 对外协议与鉴权语义的参考实现。
- [@mars-sea/dsh-commandcode-provider](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider) —— 驱动上游生成与模型发现的 DSH CommandCode adapter。
