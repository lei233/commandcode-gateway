# commandcode-gateway

**English** | [简体中文](README.zh-CN.md)

Self-hosted OpenAI-compatible Chat Completions gateway for the CommandCode API, with streaming, tool calls, and vision support.

Feature-complete: `POST /v1/chat/completions` (JSON/SSE, function tool calls, data URL images), `/v1/models` (5-minute cache + fixed fallback) and `/health` are all working (2026-11 review revisions: graceful-shutdown connection cleanup, upstream 404 passthrough, SSE empty-stream role-first frame, per-request image quota accounting).

## Confirmed Scope

- Intended for personal use on a local machine or a personal server, built on Node.js 24 + TypeScript.
- Serves Chat Completions JSON / SSE with text, function tool calls, text tool-result backfill, and data URL images in user messages; HTTP(S) image URLs return 400.
- External protocol and auth modeled on `MAXeaglet/commandcode-proxy`; upstream generation and model discovery go through the DSH CommandCode adapter (`protocol: 'cli'`).
- Message conversion and output handling follow the local `cpa-commandcode-provider` Worker.
- Auth: extract `user_...` from `Authorization: Bearer ...` / `x-api-key` (`token_user_` and similar prefixes accepted); conflicting normalized headers → 400, missing → 401. Credentials are passed through per request; the gateway itself holds no keys.
- Supported generation params: `temperature` (any finite number passed through, range judged upstream), `max_tokens`/`max_completion_tokens`, `reasoning_effort` (any non-empty string passed through; level gating handled by the adapter per model registry), `tool_choice` (auto/none); `store:false`, `user`, `metadata` silently accepted (stateless gateway — no storage/audit behavior promised); `stop` and other unmappable params return 400 (no equivalent field in the CLI wire format; the upstream adapter also rejects stop explicitly). Tool-call ids have no length cap; over-long ids are remapped to short aliases by the adapter.
- Images use per-request in-memory attachments (sharp decode validation + long-edge 1568 / 1 MiB request-version re-encode); admission limits align with the adapter's actual request budget (60 images / 64 MiB aggregate raw bytes per request, 10 MiB per image); `image_url.detail` is accepted for compatibility but not mapped upstream.
- Configuration resolves in order: built-in defaults → `config.json` → environment variables; the repo preset listens on `0.0.0.0:3050`.
- Model catalog: global 5-minute in-memory cache with a fixed-list fallback; not used to validate keys.

## Project Layout

```text
src/
  main.ts          process entry
  config.ts        configuration parsing
  server.ts        HTTP routing and request lifecycle
  auth.ts          credential parsing
  images.ts        data URL images and per-request in-memory attachments
  commandcode.ts   DSH adapter wrapper
  runtime.ts       DSH dependency boundary
  protocol/
    chat.ts        Chat → DSH request translation
    output.ts      output semantics shared by JSON/SSE
    complete.ts    Chat JSON output
    sse.ts         Chat SSE output
docs/
  architecture.md  confirmed architecture and processing schemes (Chinese)
test/
  README.md        acceptance scope
```

## Development

```sh
nvm use
npm ci
npm start
```

`npm start` listens on `0.0.0.0:3050` as preset by `config.json` (`HOST`/`PORT` can override). `npm run typecheck` runs the type check; `npm test` runs the offline suite (mock upstream + synthetic credentials); `npm run test:live` verifies against the real upstream (requires `COMMANDCODE_API_KEY` in the environment; not run by default).

Image processing depends on `sharp` (request-version re-encoding). The DSH adapter and message-layer dependencies pin the reference project's locked versions: `@mars-sea/dsh-commandcode-provider@0.17.4`, `@deepseek-ai/dsh-llm@0.2.2-rc.1`.

See [architecture.md](docs/architecture.md) for architectural boundaries and hand-off status.

## VPS Deployment (Docker)

Prerequisite: Docker Engine with the compose plugin. The image is built on the VPS itself; no registry needed.

```sh
git clone <repo-url> && cd commandcode-gateway
docker compose up -d --build
curl -s http://127.0.0.1:3050/health   # {"status":"ok"}
```

- Multi-stage build: the test stage runs `typecheck` plus the full offline test suite (in-process mock upstream — no network or real credentials needed) and must pass before the runtime stage is assembled; the runtime stage runs as a non-root user with production dependencies only.
- The base image defaults to `node:24-alpine`; if your registry mirror is restricted or you already have a pre-pulled image, override with `docker build --build-arg NODE_IMAGE=node:24.x-bookworm-slim ...` (glibc sharp binaries are covered by the lockfile as well).
- The container binds `127.0.0.1:3050` only — never exposed publicly — and is fronted by the host's existing reverse proxy; the gateway holds no credentials (keys are passed through per request), so there are no secrets to inject.
- `docker stop` sends SIGTERM, which triggers the built-in graceful shutdown (5s drain, then exit); the restart policy is `unless-stopped`.

### Reverse Proxy Integration

- SSE streaming requires buffering off: nginx `proxy_buffering off`; Caddy streams by default, set `flush_interval -1` if necessary.
- Read timeouts should be ≥ 300s to cover streaming idle limits (`CC_STREAM_IDLE_MS` defaults to 30s; heartbeat frames keep long upstream responses alive).
- If the reverse proxy is itself a Docker container: drop `ports` and reach the gateway over a shared Docker network as `commandcode-gateway:3050`.

### Operations

- Update: `git pull && docker compose up -d --build` (the old container is replaced gracefully).
- Logs: `docker compose logs -f`.
- Tuning: override `CC_*` variables under `environment` in `compose.yaml` (full list in scheme 4 of [architecture.md](docs/architecture.md)); `HOST`/`PORT` can be overridden the same way.

## Acknowledgments

- [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy) — reference implementation for the external protocol surface and auth semantics.
- [@mars-sea/dsh-commandcode-provider](https://www.npmjs.com/package/@mars-sea/dsh-commandcode-provider) — the DSH CommandCode adapter powering upstream generation and model discovery.
