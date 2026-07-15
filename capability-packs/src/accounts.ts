import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform, PLATFORMS } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

function accountPath(platformId: string): string {
  return path.join(ACCOUNTS_DIR, `${platformId}.json`);
}

export async function loadAccount(platformId: string): Promise<Record<string, string> | null> {
  try {
    return JSON.parse(await fs.readFile(accountPath(platformId), "utf8"));
  } catch {
    return null;
  }
}

/** 保存网页填来的账号配置（只接受该平台声明的字段） */
export async function saveAccount(platformId: string, values: Record<string, unknown>): Promise<void> {
  const p = platform(platformId);
  if (!p) throw new Error(`未知平台：${platformId}`);
  const clean: Record<string, string> = {};
  for (const f of p.fields) {
    const v = values[f.key];
    if (typeof v === "string" && v.trim()) clean[f.key] = v.trim();
  }
  await fs.mkdir(ACCOUNTS_DIR, { recursive: true });
  await fs.writeFile(accountPath(platformId), JSON.stringify(clean, null, 2), "utf8");
}

/** 该平台是否已配齐必填（非可选）字段 */
export async function isConfigured(platformId: string): Promise<boolean> {
  const p = platform(platformId);
  if (!p) return false;
  const acc = await loadAccount(platformId);
  if (!acc) return false;
  return p.fields.every((f) => f.label.includes("可选") || (acc[f.key] && acc[f.key].length > 0));
}

/** 某 pack 缺哪些平台账号 */
export async function missingAuth(needsAuth: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const id of needsAuth) {
    if (!(await isConfigured(id))) missing.push(id);
  }
  return missing;
}

/** 各平台配置状态 + 已填字段（密文打码），供网页展示 */
export async function accountStatus(): Promise<
  Array<{ id: string; name: string; note?: string; configured: boolean; fields: Array<{ key: string; label: string; secret: boolean; filled: boolean; value: string }> }>
> {
  const out = [];
  for (const p of PLATFORMS) {
    const acc = (await loadAccount(p.id)) ?? {};
    out.push({
      id: p.id,
      name: p.name,
      note: p.note,
      configured: await isConfigured(p.id),
      fields: p.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: !!f.secret,
        filled: !!acc[f.key],
        // 密文只回填打码占位，绝不回传明文
        value: acc[f.key] ? (f.secret ? "••••••••" : acc[f.key]) : "",
      })),
    });
  }
  return out;
}

/** 把账号凭证转成运行发布脚本时注入的环境变量（大写 PLATFORM_FIELD） */
export async function authEnv(needsAuth: string[]): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const id of needsAuth) {
    const acc = await loadAccount(id);
    if (!acc) continue;
    for (const [k, v] of Object.entries(acc)) {
      env[`${id.toUpperCase()}_${k.toUpperCase()}`] = v;
    }
  }
  return env;
}
