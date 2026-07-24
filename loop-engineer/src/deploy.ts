/**
 * W4+ — 参赛者「一键部署」到 Cloudflare Pages（CC-54 / a5f82150）。
 *
 * 参赛者点「部署」→ WorkBench 用内置 thai-tea CF 账号把作品仓的静态产物部署到 CF Pages →
 * 返回在线 URL（<name>.pages.dev）→ 发 deployed 回调 → 7 天后自动删（不占资源）。
 *
 * 凭据从本机 env 读（PAGES_CF_TOKEN_THAI_TEA + THAI_TEA_CLIENT_ID，专用于 Pages 部署，
 * 与隧道/DNS 用的账号隔离）；绝不经 hack5 过线。部署走 `npx wrangler pages deploy`（免装）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log.js";

const pexec = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";
/** 只管理我们建的项目：名字带此前缀，7 天清理也只扫这前缀，绝不误删账号里其它项目。 */
const PROJECT_PREFIX = "wb-";

export interface CfCreds {
  token: string;
  accountId: string;
}

/** 读专用于 Pages 部署的 CF 凭据；未配返回 null（/deploy 则 501 优雅拒绝，不崩）。 */
export function cfCreds(): CfCreds | null {
  const token = process.env.PAGES_CF_TOKEN_THAI_TEA || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.THAI_TEA_CLIENT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return null;
  return { token, accountId };
}

/** Pages 项目名：wb-<client>-<project>，归一成 CF 允许的小写字母数字连字符、≤54。 */
export function pagesProjectName(clientSlug: string, projectSlug: string): string {
  const raw = `${PROJECT_PREFIX}${clientSlug}-${projectSlug}`;
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe.slice(0, 54) || "wb-app";
}

async function cfFetch(
  path: string,
  method: string,
  cf: CfCreds,
  body?: unknown,
): Promise<{ success: boolean; result?: any; errors?: Array<{ code?: number; message?: string }> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as { success: boolean; result?: any; errors?: any[] };
}

/** 确保 Pages 项目存在（幂等：有则跳过，无则建，生产分支 main）。 */
async function ensureProject(name: string, cf: CfCreds): Promise<void> {
  const got = await cfFetch(`/accounts/${cf.accountId}/pages/projects/${name}`, "GET", cf);
  if (got.success) return;
  const created = await cfFetch(`/accounts/${cf.accountId}/pages/projects`, "POST", cf, {
    name,
    production_branch: "main",
  });
  if (!created.success) {
    throw new Error(`建 Pages 项目失败：${JSON.stringify(created.errors)}`);
  }
}

export interface DeployResult {
  appUrl: string;
  projectName: string;
  /** 我方托管的到期时间（ISO）；到期后 cleanup 会删。 */
  expiresAt: string;
  /** 自部署教程（让参赛者用自己的 CF 账号长期托管）。 */
  selfDeployHint: string;
}

const SELF_DEPLOY_HINT =
  "想长期托管到你自己的账号：① 注册 Cloudflare（免费）→ Workers & Pages → Create → Pages；" +
  "② 连上这个 GitHub 仓（main 分支）自动构建部署，或本机装 wrangler 后在仓目录跑 " +
  "`npx wrangler pages deploy . --project-name=<你起的名>`。我方这份托管 7 天后自动删除。";

/**
 * 把一个静态目录部署到 CF Pages，返回生产 URL（<name>.pages.dev，稳定别名）。
 * 走 npx wrangler pages deploy；token/account 经 env 传给子进程，不进 argv。
 */
export async function deployStaticDir(
  dir: string,
  clientSlug: string,
  projectSlug: string,
  cf: CfCreds,
  retentionDays = 7,
): Promise<DeployResult> {
  const name = pagesProjectName(clientSlug, projectSlug);
  await ensureProject(name, cf);
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: cf.token,
    CLOUDFLARE_ACCOUNT_ID: cf.accountId,
    GIT_TERMINAL_PROMPT: "0",
  };
  log.step(`部署到 CF Pages：${name}（${dir}）`);
  await pexec(
    "npx",
    [
      "--yes",
      "wrangler@latest",
      "pages",
      "deploy",
      dir,
      `--project-name=${name}`,
      "--branch=main",
      "--commit-dirty=true",
    ],
    { env, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
  );
  const appUrl = `https://${name}.pages.dev`;
  const expiresAt = new Date(Date.now() + retentionDays * 86400 * 1000).toISOString();
  log.ok(`已部署：${appUrl}（${retentionDays} 天后自动删）`);
  return { appUrl, projectName: name, expiresAt, selfDeployHint: SELF_DEPLOY_HINT };
}

/** 清理 N 天前我方建的 wb-* Pages 项目（尽力而为，只删本前缀 + 过期）。 */
export async function cleanupExpiredPages(maxAgeDays = 7): Promise<{ deleted: string[] }> {
  const cf = cfCreds();
  if (!cf) return { deleted: [] };
  const list = await cfFetch(`/accounts/${cf.accountId}/pages/projects?per_page=100`, "GET", cf);
  if (!list.success) return { deleted: [] };
  const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
  const deleted: string[] = [];
  for (const p of (list.result ?? []) as Array<{ name: string; created_on: string }>) {
    if (!p.name.startsWith(PROJECT_PREFIX)) continue; // 只碰我方建的
    const created = new Date(p.created_on).getTime();
    if (Number.isFinite(created) && created < cutoff) {
      const del = await cfFetch(`/accounts/${cf.accountId}/pages/projects/${p.name}`, "DELETE", cf);
      if (del.success) deleted.push(p.name);
    }
  }
  if (deleted.length) log.ok(`清理过期 Pages 项目 ${deleted.length} 个：${deleted.join(", ")}`);
  return { deleted };
}
