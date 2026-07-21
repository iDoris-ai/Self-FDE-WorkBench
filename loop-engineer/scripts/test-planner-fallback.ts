// 验证 planner 降级链:强制主选=glm(无 key→resolveProvider 抛)→ 应降级到 deepseek 成功。
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnv, loadConfig } from "../src/config.js";
import { planSpec } from "../src/planner.js";

async function main() {
  loadEnv();
  const cfg = await loadConfig();
  // 强制主选 planner = glm(本机无 GLM_API_KEY → resolveProvider 抛)→ 触发降级
  cfg.providers.planner = "glm";

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "planner-fb-"));
  await fs.writeFile(
    path.join(dir, "SPEC.md"),
    `## 一句话定位\n一个纯前端待办清单网页。\n## 核心功能\n- 添加任务（输入框+按钮，回车或点击添加）\n- 打勾完成（每条任务可切换完成态）\n- localStorage 持久化（刷新后仍在）\n## 技术方向\n纯 HTML+CSS+JS，无框架。\n`,
    "utf8",
  );

  console.log("▸ 调 planSpec(主选 glm 无 key,应降级 deepseek)...");
  await planSpec(dir, cfg, { repo: "/tmp/fake-repo" });

  const manifest = JSON.parse(await fs.readFile(path.join(dir, "loop.json"), "utf8"));
  console.log(`✓ loop.json 写出 ${manifest.tasks.length} 个任务(降级 planner 成功产出):`);
  for (const t of manifest.tasks.slice(0, 6)) console.log(`   ${t.id} ${t.title}`);
  if (!manifest.tasks.length) throw new Error("降级后仍无任务");
  await fs.rm(dir, { recursive: true, force: true });
  console.log("\n🎉 planner 降级链验证通过(主选挂→自动降级到下一个 provider 成功)");
}

main().catch((e) => {
  console.error("✗ 测试失败:", e);
  process.exit(1);
});
