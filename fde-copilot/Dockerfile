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
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

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
CMD ["pnpm", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3939"]
