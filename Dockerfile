# 基础镜像可覆盖（如本地预拉取的 glibc 变体）：--build-arg NODE_IMAGE=...
ARG NODE_IMAGE=node:24-alpine

# ---- 测试阶段：typecheck + 离线测试（构建即门禁，mock 上游进程内自包含）----
FROM ${NODE_IMAGE} AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY config.json ./
COPY src/ src/
COPY test/ test/
RUN npm run typecheck && npm test

# ---- 运行阶段：仅生产依赖，无构建步骤（Node 24 原生跑 TS）----
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force
# src 从测试阶段复制：强制测试先跑（门禁），且保证运行的就是被测过的代码
COPY --from=test /app/src src/
COPY config.json ./
USER node
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??'3050')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 直接跑 node 而非 npm start：SIGTERM 直达进程，走 src/main.ts 的优雅关停
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
