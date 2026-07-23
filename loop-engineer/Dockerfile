# CC-58 · loop-engineer 容器镜像
# agentic 编码运行时：需 git（clone/worktree/push）+ claude CLI（providers.ts spawn "claude -p"）+ tsx。
# 默认云模式（EXECUTION_MODE=api）：认证走 .env / CF Secret 的云 key，零本机订阅。
# 构建上下文 = 本目录（loop-engineer/）。
FROM node:22-bookworm-slim

# git：仓库 clone/worktree/push；tini：正确回收 claude -p 子进程；ca-certificates：https
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# pnpm（corepack）+ claude CLI（agentic 运行时，全局装到 PATH，靠 env 覆盖端点，无需 login）
RUN corepack enable && npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 先装依赖（含 devDep tsx，运行 src/server.ts 需要）——利用层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 再拷源码
COPY . .

# 容器里绑 0.0.0.0 才能被前置 Worker/DO 触达；默认云模式；关掉本地 watchDirs（云端只走 HTTP /plan）
ENV NODE_ENV=production \
    EXECUTION_MODE=api \
    LOOP_HTTP_HOST=0.0.0.0 \
    LOOP_HTTP_PORT=4050 \
    LOOP_WATCH_DIRS=""

EXPOSE 4050
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
