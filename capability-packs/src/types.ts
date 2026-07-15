import { z } from "zod";

// —— Pack 清单（packs/<id>/pack.json）——
export const PackBackend = z.object({
  /** local=跑本地命令；script=跑 blog 脚本；cli=跑 CLI(agent-reach)；skill=由 agent 用 Skill 工具；http=调 API */
  type: z.enum(["local", "script", "cli", "skill", "http"]),
  /** local/script/cli：可执行命令或脚本路径（相对能力包根或绝对） */
  cmd: z.string().optional(),
  /** 运行工作目录 */
  cwd: z.string().optional(),
  /** skill 型：agent 应调用的 skill 名 */
  skill: z.string().optional(),
  /** 给 agent 的调用说明 */
  note: z.string().optional(),
});
export type PackBackend = z.infer<typeof PackBackend>;

export const Pack = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["generate", "publish", "research"]),
  description: z.string().default(""),
  backend: PackBackend,
  /** 依赖哪些平台账号（platform id），发布类必填 */
  needsAuth: z.array(z.string()).default([]),
  /** 输入契约的简单说明（键 → 说明） */
  inputs: z.record(z.string(), z.string()).default({}),
});
export type Pack = z.infer<typeof Pack>;

// —— 平台账号：网页表单按 fields 渲染，用户填，存 accounts/<id>.json ——
export interface PlatformField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}
export interface Platform {
  id: string;
  name: string;
  note?: string;
  fields: PlatformField[];
}

/** 内置平台定义（网页据此渲染配置表单） */
export const PLATFORMS: Platform[] = [
  {
    id: "wechat",
    name: "微信公众号",
    note: "公众平台 → 设置与开发 → 基本配置，拿 AppID / AppSecret；并把服务器出口 IP 加入白名单。",
    fields: [
      { key: "appId", label: "AppID", placeholder: "wx..." },
      { key: "appSecret", label: "AppSecret", secret: true },
    ],
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    note: "小红书无官方发帖 API，走已登录会话。web 端登录后从浏览器复制 Cookie 粘进来（会过期，需定期更新）。",
    fields: [
      { key: "cookie", label: "登录 Cookie", secret: true, placeholder: "a1=...; web_session=..." },
      { key: "userAgent", label: "User-Agent（可选）", placeholder: "Mozilla/5.0 ..." },
    ],
  },
];

export function platform(id: string): Platform | undefined {
  return PLATFORMS.find((p) => p.id === id);
}
