/** @type {import('next').NextConfig} */
const nextConfig = {
  // The agent runner spawns the Claude Code runtime; keep it out of the bundle trace.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
