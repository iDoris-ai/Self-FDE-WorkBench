import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.js";
import { scanJobs } from "./jobs.js";
import { loadLedger } from "./usage.js";
import { log } from "./log.js";

// —— 运行态（操作台：选 job → 运行 → 实时进度）——
interface RunState {
  running: boolean;
  jobId: string | null;
  startedAt: string | null;
  log: string[];
  exitCode: number | null;
}
const runState: RunState = { running: false, jobId: null, startedAt: null, log: [], exitCode: null };
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function pushLog(chunk: string): void {
  for (const line of stripAnsi(chunk).split("\n")) {
    const t = line.replace(/\s+$/, "");
    if (t) runState.log.push(t);
  }
  if (runState.log.length > 600) runState.log = runState.log.slice(-600);
}
function startRun(jobDir: string, jobId: string): void {
  runState.running = true;
  runState.jobId = jobId;
  runState.startedAt = new Date().toISOString();
  runState.log = [];
  runState.exitCode = null;
  // 只跑该 job：LOOP_WATCH_DIRS 指向它所在目录；provider env 由启动面板时继承
  const child = spawn("pnpm", ["exec", "tsx", "src/cli.ts", "run", "--drain"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, LOOP_WATCH_DIRS: jobDir },
  });
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("close", (code) => {
    runState.running = false;
    runState.exitCode = code;
    pushLog(`[结束] 退出码 ${code}`);
  });
  child.on("error", (e) => {
    runState.running = false;
    pushLog(`[错误] ${e.message}`);
  });
}
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

// 贯穿三个 app 的工作台切换条（URL 可用 WB_*_URL 环境变量覆盖，默认本地端口）
function wbSwitcher(current: string): string {
  const u = {
    fde: process.env.WB_FDE_URL || "http://localhost:3939",
    loop: process.env.WB_LOOP_URL || "http://localhost:4040",
    packs: process.env.WB_PACKS_URL || "http://localhost:4141",
    site: process.env.WB_SITE_URL || "http://localhost:8080",
  };
  const a = (k: string, url: string, label: string) =>
    `<a href="${url}"${k === current ? ' class="cur"' : ""}>${label}</a>`;
  return (
    `<div class="wbnav"><span class="wbbrand">WORKBENCH</span>` +
    a("fde", u.fde, "① 需求 fde-copilot") +
    `<span class="wbsep">→</span>` +
    a("loop", u.loop, "② 造 loop-engineer") +
    `<span class="wbsep">→</span>` +
    a("packs", u.packs, "③ 能力 capability-packs") +
    `<a class="wbsite" href="${u.site}">官网 ↗</a></div>`
  );
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Loop-Engineer</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--border:#2b333f;--text:#e6edf3;--muted:#8b98a9;--accent:#4f9dff;--green:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC",sans-serif;font-size:14px}
.wrap{max-width:900px;margin:0 auto;padding:24px}
.hd{display:flex;align-items:center;justify-content:space-between}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
#langbtn{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
#langbtn:hover{border-color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px}
.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:700;margin-top:6px}
.card .v.accent{color:var(--accent)}.card .v.green{color:var(--green)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px}
th{color:var(--muted);font-weight:600}tr:last-child td{border-bottom:none}
td.num{text-align:right;font-variant-numeric:tabular-nums}
h2{font-size:14px;color:var(--muted);margin:26px 0 10px}
.badge{padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--border)}
.done{color:var(--green);border-color:var(--green)}.failed{color:#f85149;border-color:#f85149}
.dim{color:var(--muted)}
.wbnav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:8px 16px;border-bottom:1px solid var(--border);background:#0d1117;color:var(--muted);position:sticky;top:0;z-index:10}.wbnav a{color:var(--muted);text-decoration:none;padding:3px 9px;border-radius:6px}.wbnav a:hover{color:var(--text);background:var(--panel)}.wbnav a.cur{color:#041225;background:var(--accent);font-weight:600}.wbnav .wbbrand{font-weight:700;letter-spacing:.08em;color:var(--text);margin-right:2px}.wbnav .wbsep{color:#3a3f47}.wbnav .wbsite{margin-left:auto}
</style></head><body><!--WBNAV--><div class="wrap">
<div class="hd"><h1 data-i18n="title">Loop-Engineer 用量面板</h1><button id="langbtn">EN</button></div>
<div class="sub" id="sub">…</div>
<h2 data-i18n="console">操作台</h2>
<div class="card">
  <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <select id="jobsel" style="flex:1;min-width:180px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:8px;font:inherit"></select>
    <button class="run p" id="runbtn" style="background:var(--accent);border:1px solid var(--accent);color:#041225;font-weight:600;border-radius:8px;padding:8px 14px;cursor:pointer">▶ <span data-i18n="run">运行</span></button>
    <button class="run" id="jbtn" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer" data-i18n="journalBtn">Journal</button>
    <span id="runstatus" style="color:var(--muted);font-size:12px"></span>
  </div>
  <pre id="progress" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:var(--muted);margin-top:10px;max-height:280px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px"></pre>
</div>
<div class="cards">
  <div class="card"><div class="k" data-i18n="cTok">总 Token（输入+输出）</div><div class="v accent" id="tok">—</div></div>
  <div class="card"><div class="k" data-i18n="cCu">计算秒（墙钟）</div><div class="v" id="cu">—</div></div>
  <div class="card"><div class="k" data-i18n="cCost">成本估算</div><div class="v green" id="cost">—</div></div>
  <div class="card"><div class="k" data-i18n="cCalls">调用次数</div><div class="v" id="calls">—</div></div>
</div>
<h2 data-i18n="byProv">按模型/供应商</h2>
<table id="prov"><thead><tr><th data-i18n="hProv">供应商</th><th class="num" data-i18n="hIn">输入</th><th class="num" data-i18n="hOut">输出</th><th class="num" data-i18n="hCu">计算秒</th><th class="num" data-i18n="hCost">成本估算</th><th class="num" data-i18n="hCalls">次数</th></tr></thead><tbody></tbody></table>
<h2 data-i18n="hJobs">任务</h2>
<table id="jobs"><thead><tr><th data-i18n="hJob">Job</th><th data-i18n="hTask">任务</th><th class="num" data-i18n="hDone">done/总</th></tr></thead><tbody></tbody></table>
<script>
const T={zh:{title:'Loop-Engineer 用量面板',cTok:'总 Token（输入+输出）',cCu:'计算秒（墙钟）',cCost:'成本估算',cCalls:'调用次数',byProv:'按模型/供应商',hProv:'供应商',hIn:'输入',hOut:'输出',hCu:'计算秒',hCost:'成本估算',hCalls:'次数',hJobs:'任务',hJob:'Job',hTask:'任务',hDone:'done/总',updated:'更新于',refresh:'每 3 分钟自动刷新',noUsage:'还没有用量记录，跑一次 run 就有了',noJobs:'watchDirs 下暂无 job',fail:'加载失败：',console:'操作台',run:'运行',journalBtn:'Journal',running:'运行中',idle:'空闲',ended:'结束'},
en:{title:'Loop-Engineer Usage',cTok:'Total tokens (in+out)',cCu:'Compute seconds (wall)',cCost:'Est. cost',cCalls:'Calls',byProv:'By model / provider',hProv:'Provider',hIn:'Input',hOut:'Output',hCu:'Compute',hCost:'Est. cost',hCalls:'Calls',hJobs:'Tasks',hJob:'Job',hTask:'Task',hDone:'done/total',updated:'Updated',refresh:'auto-refresh every 3 min',noUsage:'No usage yet — run once to populate',noJobs:'No jobs under watchDirs',fail:'Load failed: ',console:'Console',run:'Run',journalBtn:'Journal',running:'running',idle:'idle',ended:'ended'}};
let lang=localStorage.getItem('le:lang')||'zh';let lastAt='—';
const fT=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':''+n;
const fC=u=>u>=0.01?'$'+u.toFixed(2):'$'+u.toFixed(4);
const fS=ms=>{const s=Math.round(ms/1000);return s>=60?Math.floor(s/60)+'m'+(s%60)+'s':s+'s'};
function applyLang(){document.querySelectorAll('[data-i18n]').forEach(e=>{const k=e.getAttribute('data-i18n');if(T[lang][k])e.textContent=T[lang][k]});document.getElementById('langbtn').textContent=lang==='zh'?'EN':'中';document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.getElementById('sub').textContent=T[lang].updated+' '+lastAt+' · '+T[lang].refresh}
document.getElementById('langbtn').onclick=()=>{lang=lang==='zh'?'en':'zh';localStorage.setItem('le:lang',lang);applyLang();load()};
async function load(){
 try{
  const u=await (await fetch('/api/usage')).json();const t=u.total;lastAt=u.updatedAt||'—';
  document.getElementById('tok').textContent=fT(t.inputTokens+t.outputTokens);
  document.getElementById('cu').textContent=fS(t.computeMs);
  document.getElementById('cost').textContent=fC(t.costUsd);
  document.getElementById('calls').textContent=t.calls;
  document.getElementById('sub').textContent=T[lang].updated+' '+lastAt+' · '+T[lang].refresh;
  const pb=document.querySelector('#prov tbody');pb.innerHTML='';
  for(const [name,x] of Object.entries(u.byProvider||{})){const tr=document.createElement('tr');
   tr.innerHTML='<td>'+name+'</td><td class="num">'+fT(x.inputTokens)+'</td><td class="num">'+fT(x.outputTokens)+'</td><td class="num">'+fS(x.computeMs)+'</td><td class="num">'+fC(x.costUsd)+'</td><td class="num">'+x.calls+'</td>';pb.appendChild(tr)}
  if(!Object.keys(u.byProvider||{}).length)pb.innerHTML='<tr><td colspan=6 class=dim>'+T[lang].noUsage+'</td></tr>';
  const s=await (await fetch('/api/status')).json();const jb=document.querySelector('#jobs tbody');jb.innerHTML='';
  for(const j of s.jobs||[])for(const tk of j.tasks){const tr=document.createElement('tr');
   tr.innerHTML='<td class=dim>'+j.id+'</td><td><span class="badge '+tk.status+'">'+tk.status+'</span> '+tk.title+'</td><td class="num">'+j.done+'/'+j.total+'</td>';jb.appendChild(tr)}
  if(!(s.jobs||[]).length)jb.innerHTML='<tr><td colspan=3 class=dim>'+T[lang].noJobs+'</td></tr>';
 }catch(e){document.getElementById('sub').textContent=T[lang].fail+e}
}
let progTimer=null;
async function fillJobs(){
 const s=await (await fetch('/api/status')).json();const sel=document.getElementById('jobsel');const cur=sel.value;
 sel.innerHTML=(s.jobs||[]).map(j=>'<option value="'+j.id+'">'+j.id+' ('+j.done+'/'+j.total+')</option>').join('')||('<option value="">'+T[lang].noJobs+'</option>');
 if(cur)sel.value=cur;
}
async function runJob(){
 const id=document.getElementById('jobsel').value;if(!id)return;
 const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:id})});
 const j=await r.json();if(!r.ok){document.getElementById('runstatus').textContent=j.error||'x';return;}
 startPolling();
}
function startPolling(){if(progTimer)clearInterval(progTimer);pollProg();progTimer=setInterval(pollProg,2000);}
async function pollProg(){
 const p=await (await fetch('/api/progress')).json();
 const box=document.getElementById('progress');const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40;
 box.textContent=(p.log||[]).join('\\n');if(atBottom)box.scrollTop=box.scrollHeight;
 document.getElementById('runstatus').textContent=p.running?(T[lang].running+' '+(p.jobId||'')):(p.exitCode!=null?(T[lang].ended+' exit '+p.exitCode):T[lang].idle);
 document.getElementById('runbtn').disabled=!!p.running;
 if(!p.running&&progTimer){clearInterval(progTimer);progTimer=null;fillJobs();load();}
}
async function loadJournal(){
 const id=document.getElementById('jobsel').value;if(!id)return;
 const j=await (await fetch('/api/journal?job='+encodeURIComponent(id))).json();
 document.getElementById('progress').textContent=j.content||'(no journal)';
}
document.getElementById('runbtn').onclick=runJob;
document.getElementById('jbtn').onclick=loadJournal;
applyLang();load();fillJobs();pollProg();setInterval(load,180000);setInterval(fillJobs,60000);
</script></div></body></html>`;

export async function startDashboard(port: number): Promise<void> {
  const config = await loadConfig();

  const server = createServer(async (req, res) => {
    // 只接受本机 Host，挡 DNS rebinding（/api/run 会 spawn 自主编码器，Cloudflare Access
    // 挡不住 rebinding 直连 127.0.0.1，故此校验是必须的正交一层）
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden host");
      return;
    }
    try {
      if (req.url === "/api/usage") {
        const ledger = await loadLedger();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ledger));
        return;
      }
      if (req.url === "/api/status") {
        const jobs = await scanJobs(config.watchDirs);
        const out = jobs.map((j) => ({
          id: j.manifest.id,
          done: j.manifest.tasks.filter((t) => t.status === "done").length,
          total: j.manifest.tasks.length,
          tasks: j.manifest.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs: out }));
        return;
      }
      if (req.url === "/api/progress") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runState));
        return;
      }
      if (req.url?.startsWith("/api/journal")) {
        const jobId = new URL(req.url, "http://x").searchParams.get("job");
        const job = (await scanJobs(config.watchDirs)).find((j) => j.manifest.id === jobId);
        let content = "";
        if (job) content = await fs.readFile(path.join(job.jobDir, ".loop", "journal.md"), "utf8").catch(() => "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content }));
        return;
      }
      if (req.url === "/api/run" && req.method === "POST") {
        if (runState.running) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "已有任务在运行" }));
          return;
        }
        const body = await readBody(req);
        const job = (await scanJobs(config.watchDirs)).find((j) => j.manifest.id === body.jobId);
        if (!job) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "job 不存在" }));
          return;
        }
        startRun(job.jobDir, job.manifest.id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ started: true }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE.replace("<!--WBNAV-->", wbSwitcher("loop")));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  // 默认只绑本机
  server.listen(port, "127.0.0.1", () => {
    log.ok(`用量面板已启动：http://127.0.0.1:${port}`);
  });
}
