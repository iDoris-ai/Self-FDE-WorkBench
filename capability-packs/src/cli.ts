#!/usr/bin/env -S npx tsx
import { loadPacks } from "./registry.js";
import { accountStatus } from "./accounts.js";
import { invoke } from "./invoke.js";

function parseInput(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      out[args[i].slice(2)] = args[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list": {
      const packs = await loadPacks();
      for (const p of packs) {
        const auth = p.needsAuth.length ? `需账号:${p.needsAuth.join(",")}` : "无需账号";
        console.log(`  [${p.category}] ${p.id.padEnd(24)} ${p.name}  (${auth})`);
      }
      break;
    }
    case "accounts": {
      for (const a of await accountStatus()) {
        console.log(`  ${a.configured ? "✓" : "·"} ${a.id.padEnd(14)} ${a.name}  ${a.configured ? "已配置" : "未配置"}`);
      }
      break;
    }
    case "invoke": {
      const id = rest[0];
      if (!id) return console.log("用法: packs invoke <packId> [--key value ...]");
      const r = await invoke(id, parseInput(rest.slice(1)));
      console.log(r.message);
      if (r.blocked) console.log("  → 去网页配置账号: pnpm web");
      if (r.mode === "skill") console.log(`  → agent 请用 Skill 调用: ${r.skill}`);
      if (r.output) console.log(r.output);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    default:
      console.log("Capability Packs CLI");
      console.log("  list                      列出所有能力包");
      console.log("  accounts                  各平台账号配置状态");
      console.log("  invoke <id> [--k v ...]   调一个能力包");
      console.log("  （网页: pnpm web → http://127.0.0.1:4141）");
      process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(1);
});
