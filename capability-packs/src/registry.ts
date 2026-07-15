import { promises as fs } from "node:fs";
import path from "node:path";
import { Pack } from "./types.js";
import type { Pack as PackT } from "./types.js";
import { ROOT } from "./accounts.js";

const PACKS_DIR = path.join(ROOT, "packs");

/** 扫描 packs/<id>/pack.json，解析成注册表 */
export async function loadPacks(): Promise<PackT[]> {
  let dirs: string[] = [];
  try {
    const entries = await fs.readdir(PACKS_DIR, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const packs: PackT[] = [];
  for (const d of dirs) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(PACKS_DIR, d, "pack.json"), "utf8"));
      packs.push(Pack.parse(raw));
    } catch {
      /* 跳过坏 manifest */
    }
  }
  return packs.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
}

export async function getPack(id: string): Promise<PackT | null> {
  return (await loadPacks()).find((p) => p.id === id) ?? null;
}
