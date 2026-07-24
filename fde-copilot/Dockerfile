# syntax=docker/dockerfile:1
# CC-58 · fde-copilot 容器镜像（Next.js 15）
# 诉求→规格 对话器。full agent-sdk 路径 spawn claude 运行时（需 claude CLI）；
# 默认云模式（EXECUTION_MODE=api）：认证走云端 Anthropic 兼容端点（DeepSeek）/ HiLinkup，零本机订阅。
# 构建上下文 = 本目录（fde-copilot/）。
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && npm install -g @anthropic-ai/claude-code
WORKDIR /app

# 依赖层（缓存）
# 钉 pnpm 10.15.1：pnpm 11+ 把"忽略构建脚本"当硬错误(ERR_PNPM_IGNORED_BUILDS),10.x 只警告。
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# BuildKit 缓存挂载：pnpm store 跨构建持久化，飘忽网络下重试不用重下已成功的包；
# 拉高 fetch 重试/超时，熬过泰国→npm 的大二进制(@next/swc、claude-agent-sdk)ECONNRESET。
RUN --mount=type=cache,target=/pnpm-store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10.15.1 --activate \
 && pnpm install --frozen-lockfile \
      --config.store-dir=/pnpm-store \
      --config.fetch-retries=20 \
      --config.fetch-retry-maxtimeout=300000 \
      --config.fetch-timeout=600000

# 构建层（next build）
FROM deps AS build
COPY . .
RUN pnpm run build

# 运行层
FROM base AS run
COPY --from=build /app ./
# 容器里绑 0.0.0.0；默认云模式
ENV NODE_ENV=production \
    EXECUTION_MODE=api
EXPOSE 3939
ENTRYPOINT ["tini", "--"]
# 直接跑 next 二进制,不经 pnpm exec —— 避免运行时 pnpm 重下+依赖检查(无 TTY 崩溃)
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3939"]
