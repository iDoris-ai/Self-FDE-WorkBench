// 集成验证：ensureClone + pushRefs 真跑一遍（本地 bare 仓当「远程」，不碰 GitHub/token）。
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { isRemoteRepo, ensureClone, pushRefs, isGitRepo, assertAllowedPushHost } from "../src/git.js";

const pexec = promisify(execFile);
const g = (cwd: string, ...args: string[]) => pexec("git", ["-C", cwd, ...args]).then((r) => r.stdout.trim());

async function main() {
  // isRemoteRepo 判定
  const cases: [string, boolean][] = [
    ["https://github.com/clestons/groupbuy-e2e-1353", true],
    ["https://github.com/clestons/groupbuy-e2e-1353.git", true],
    ["git@github.com:clestons/x.git", true],
    ["/Users/jason/local/repo", false],
    ["../fde-copilot/clients/x", false],
  ];
  for (const [url, want] of cases) {
    const got = isRemoteRepo(url);
    if (got !== want) throw new Error(`isRemoteRepo(${url})=${got}, want ${want}`);
  }
  console.log("✓ isRemoteRepo 判定正确");

  // assertAllowedPushHost：github 放行、其它 https host 抛错、本地/ssh 放行
  assertAllowedPushHost("https://github.com/clestons/x.git"); // 不抛
  assertAllowedPushHost("/local/path"); // 非 URL，不抛
  assertAllowedPushHost("git@github.com:clestons/x.git"); // 非 https，不抛
  let threw = false;
  try {
    assertAllowedPushHost("https://evil.example.com/x.git");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("assertAllowedPushHost 未挡住非白名单 host");
  console.log("✓ assertAllowedPushHost host 白名单生效（挡住非 github https）");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loop-remote-test-"));
  const remote = path.join(tmp, "remote.git");
  const seed = path.join(tmp, "seed");
  const localClone = path.join(tmp, "job", ".loop-repo");

  // 造「远程」bare 仓 + 初始 main 提交
  await pexec("git", ["init", "--bare", "-b", "main", remote]);
  await pexec("git", ["init", "-b", "main", seed]);
  await g(seed, "config", "user.email", "t@t");
  await g(seed, "config", "user.name", "t");
  await fs.writeFile(path.join(seed, "README.md"), "seed\n");
  await g(seed, "add", "-A");
  await g(seed, "commit", "-m", "init");
  await g(seed, "remote", "add", "origin", remote);
  await g(seed, "push", "origin", "main");

  // 1) ensureClone：远程 → 本地 clone
  await ensureClone(remote, localClone, "main");
  if (!(await isGitRepo(localClone))) throw new Error("ensureClone 后不是 git 仓");
  // 干净化：origin 不该残留 token（这里本就无 token，验证 URL 被设回干净远程）
  const originUrl = await g(localClone, "remote", "get-url", "origin");
  if (originUrl !== remote) throw new Error(`origin URL=${originUrl}, want ${remote}`);
  console.log("✓ ensureClone 拉下远程仓，origin 干净");

  // 2) 模拟 loop：建 integration 分支 + 一个编码提交
  await g(localClone, "config", "user.email", "loop@t");
  await g(localClone, "config", "user.name", "loop");
  await g(localClone, "branch", "loop/integration", "main");
  await g(localClone, "checkout", "loop/integration");
  await fs.writeFile(path.join(localClone, "app.js"), "console.log('coded by loop')\n");
  await g(localClone, "add", "-A");
  await g(localClone, "commit", "-m", "feat: loop coded app");

  // 3) pushRefs：回推 integration 分支 + fast-forward main
  const r = await pushRefs(localClone, remote, [
    "loop/integration:refs/heads/loop/integration",
    "loop/integration:main",
  ]);
  if (!r.pushed) throw new Error(`pushRefs 失败：${r.detail}`);
  console.log(`✓ pushRefs：${r.detail}`);

  // 4) 核对「远程」真收到：main 和 loop/integration 都含 app.js 提交
  const remoteBranches = await g(remote, "branch", "--list");
  if (!remoteBranches.includes("loop/integration")) throw new Error("远程缺 loop/integration 分支");
  const mainLog = await g(remote, "log", "main", "--oneline");
  if (!mainLog.includes("loop coded app")) throw new Error("远程 main 未收到编码提交(非 FF?)");
  const mainFiles = await g(remote, "ls-tree", "--name-only", "main");
  if (!mainFiles.split("\n").includes("app.js")) throw new Error("远程 main 无 app.js");
  console.log("✓ 远程 main + loop/integration 均收到 loop 编码成果");

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("\n🎉 远程 clone→编码→回推 全链路本地验证通过");
}

main().catch((e) => {
  console.error("✗ 测试失败：", e);
  process.exit(1);
});
