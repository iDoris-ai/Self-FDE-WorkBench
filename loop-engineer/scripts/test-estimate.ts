// CC-62：验证 /estimate 预估器的档位判定与积分区间。
import assert from "node:assert/strict";
import { estimateJob } from "../src/estimate.js";

// 1. 极简 idea → XS/S 低档
const xs = estimateJob({ idea: "一个显示当前时间的静态页" });
assert.ok(["XS", "S"].includes(xs.tier), `极简应 XS/S,实际 ${xs.tier}`);
assert.ok(xs.creditsHigh <= 15);

// 2. 多功能点 spec → 至少 M
const mSpec = estimateJob({
  spec: `## 功能\n- 添加任务\n- 打勾完成\n- 删除任务\n- localStorage 持久化\n- 分类筛选\n- 拖拽排序`,
});
assert.ok(["M", "L"].includes(mSpec.tier), `6 功能点应 M/L,实际 ${mSpec.tier}`);
assert.equal(mSpec.signals.featureCount, 6);

// 3. 含后端/数据库信号 → 加权上抬 + hasBackend=true
const backend = estimateJob({
  spec: `- 用户登录注册\n- 后端 API 存订单到数据库\n- 实时航班价格抓取`,
});
assert.equal(backend.signals.hasBackend, true);
assert.ok(["M", "L"].includes(backend.tier), `含后端多信号应 M/L,实际 ${backend.tier}`);

// 4. 区间自洽 + 建议按 creditsHigh 预检
for (const r of [xs, mSpec, backend]) {
  assert.ok(r.creditsLow > 0 && r.creditsHigh >= r.creditsLow, "区间必须 low>0 且 high>=low");
  assert.ok(typeof r.note === "string" && r.note.length > 0);
}

// 5. 空输入 → 最小档 + 提示
const empty = estimateJob({});
assert.equal(empty.signals.chars, 0);
assert.ok(empty.note.includes("无输入"));

// 6. spec 优先于 idea(两者都给时按 spec)
const both = estimateJob({ idea: "x", spec: "- a\n- b\n- c\n- d\n- e\n- f\n- g" });
assert.equal(both.signals.featureCount, 7);

console.log("🎉 estimate 档位/区间/信号 —— 全部断言通过");
for (const [name, r] of Object.entries({ xs, mSpec, backend })) {
  console.log(`   ${name}: tier=${r.tier} credits=${r.creditsLow}-${r.creditsHigh}`);
}
