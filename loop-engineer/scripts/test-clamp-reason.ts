// CC-60：验证 W5 failed 回调的 error 摘要收敛到 ≤500 字。
import assert from "node:assert/strict";
import { clampReason, callbackBody } from "../src/callback.js";

// 1. 短文本原样返回（仅折叠空白）
assert.equal(clampReason("coding 阶段 1/3 个任务失败"), "coding 阶段 1/3 个任务失败");
assert.equal(clampReason("a\n\nb   c"), "a b c");

// 2. 超长截断到 ≤500 且带后缀
const long = "x".repeat(2000);
const clamped = clampReason(long);
assert.ok(clamped.length <= 500, `截断后长度应 ≤500，实际 ${clamped.length}`);
assert.ok(clamped.endsWith("…(truncated)"), "超长应追加 …(truncated)");

// 3. 自定义上限
assert.ok(clampReason(long, 50).length <= 50);

// 4. 端到端:failed 回调 body 里的 error 一定 ≤500（哪怕上游塞进整段日志）
const body = JSON.parse(
  callbackBody({
    event: "failed",
    clientSlug: "c",
    projectSlug: "p",
    repo: "clestons/cheap-flight-go",
    error: "gate 命令输出\n".repeat(500),
  }),
);
assert.equal(body.event, "failed");
assert.ok(typeof body.error === "string" && body.error.length <= 500, "回调 error 必须 ≤500 字");

// 5. 无 error 的事件不带该字段
const ok = JSON.parse(
  callbackBody({ event: "coding_done", clientSlug: "c", projectSlug: "p", repo: "r" }),
);
assert.ok(!("error" in ok), "非失败事件不应带 error");

console.log("🎉 clampReason / failed 回调 error ≤500 字 —— 全部断言通过");
