/**
 * CC-62 — /estimate 事前积分预估。
 *
 * 把「客户 idea / spec」估成积分区间，供 hack5 在建 job 前做余额预检:够则放行、不够提示充值。
 * 设计取舍:**纯启发式,不真跑 planner** —— 预估必须秒级返回且零 token 成本(预估本身不该烧积分)。
 * 用复杂度信号(功能点数 + 是否含后端/多页 + 篇幅)映射到档位,档位→积分区间来自实测校准的种子表。
 *
 * 换算(与 CC-54 / hack5 同源):积分 = ceil(成本USD × 100)。1 积分 = $0.01 成本 = $0.02 客户价(2× 加价)。
 * 种子表按 coder=DeepSeek v4-pro 正常路径估;若降级兜底 HiLinkup,同档约 ×3-4(见 note)。
 */

export type Tier = "XS" | "S" | "M" | "L";

export interface EstimateInput {
  idea?: string;
  spec?: string;
}

export interface EstimateSignals {
  featureCount: number;
  hasBackend: boolean;
  multiPage: boolean;
  chars: number;
}

export interface EstimateResult {
  tier: Tier;
  creditsLow: number;
  creditsHigh: number;
  note: string;
  signals: EstimateSignals;
}

// 档位→积分区间(种子表 · coder=DeepSeek v4-pro 正常路径 · 跑完真实 job 回填校准)。
const TIER_CREDITS: Record<Tier, [number, number]> = {
  XS: [3, 8], // 单文件微改
  S: [5, 15], // 1-2 文件小功能
  M: [15, 50], // 多文件骨架 + 数个 feature
  L: [50, 200], // 全新 app 多任务 + 返工
};

const BACKEND_RE =
  /后端|服务端|api\b|接口|数据库|db\b|sql|server|鉴权|登录|注册|auth|支付|订单|爬虫|抓取|scrape|实时|websocket|定时|队列/i;
const MULTIPAGE_RE = /多页|路由|route|页面|导航|dashboard|后台|管理端|列表页|详情页/i;

/** 数 spec 里的功能点(bullet / 编号行);无 bullet 的 idea 按句子数粗估。 */
function countFeatures(text: string): number {
  const bullets = (text.match(/^\s*(?:[-*+]|\d+[.)、])\s+/gm) ?? []).length;
  if (bullets > 0) return bullets;
  const sentences = text
    .split(/[。.!?！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  return Math.max(1, sentences.length);
}

/** 估一个 idea/spec 的积分区间 + 档位 + 信号。纯函数,确定性,便于测试与 hack5 对齐。 */
export function estimateJob(input: EstimateInput): EstimateResult {
  const text = (input.spec ?? input.idea ?? "").trim();
  const chars = text.length;
  const featureCount = countFeatures(text);
  const hasBackend = BACKEND_RE.test(text);
  const multiPage = MULTIPAGE_RE.test(text);

  // 复杂度打分:功能点是主因,后端/多页/长篇各加权。
  let score = featureCount;
  if (hasBackend) score += 3;
  if (multiPage) score += 2;
  if (chars > 1200) score += 1;

  let tier: Tier;
  if (score <= 2) tier = "XS";
  else if (score <= 5) tier = "S";
  else if (score <= 11) tier = "M";
  else tier = "L";

  const [creditsLow, creditsHigh] = TIER_CREDITS[tier];
  const empty = chars === 0;
  const note = empty
    ? "无输入文本,按最小档估;请传 idea 或 spec 以获得准确预估。"
    : `档位 ${tier}(功能点≈${featureCount}${hasBackend ? " · 含后端" : ""}${multiPage ? " · 多页" : ""})。` +
      `积分=ceil(成本×100),按正常走 DeepSeek 估;若 DeepSeek 不可用兜底 HiLinkup,同档约 ×3-4。` +
      `建议按 creditsHigh 预检余额。`;

  return { tier, creditsLow, creditsHigh, note, signals: { featureCount, hasBackend, multiPage, chars } };
}
