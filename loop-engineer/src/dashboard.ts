import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { scanJobs } from "./jobs.js";
import { loadLedger } from "./usage.js";
import { log } from "./log.js";

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Loop-Engineer 用量面板</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--border:#2b333f;--text:#e6edf3;--muted:#8b98a9;--accent:#4f9dff;--green:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC",sans-serif;font-size:14px}
.wrap{max-width:900px;margin:0 auto;padding:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
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
</style></head><body><div class="wrap">
<h1>Loop-Engineer 用量面板</h1>
<div class="sub" id="sub">加载中…</div>
<div class="cards">
  <div class="card"><div class="k">总 Token（输入+输出）</div><div class="v accent" id="tok">—</div></div>
  <div class="card"><div class="k">计算秒（墙钟）</div><div class="v" id="cu">—</div></div>
  <div class="card"><div class="k">成本估算</div><div class="v green" id="cost">—</div></div>
  <div class="card"><div class="k">调用次数</div><div class="v" id="calls">—</div></div>
</div>
<h2>按模型/供应商</h2>
<table id="prov"><thead><tr><th>供应商</th><th class="num">输入</th><th class="num">输出</th><th class="num">计算秒</th><th class="num">成本估算</th><th class="num">次数</th></tr></thead><tbody></tbody></table>
<h2>任务</h2>
<table id="jobs"><thead><tr><th>Job</th><th>任务</th><th class="num">done/总</th></tr></thead><tbody></tbody></table>
<script>
const fT=n=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':''+n;
const fC=u=>u>=0.01?'$'+u.toFixed(2):'$'+u.toFixed(4);
const fS=ms=>{const s=Math.round(ms/1000);return s>=60?Math.floor(s/60)+'m'+(s%60)+'s':s+'s'};
async function load(){
 try{
  const u=await (await fetch('/api/usage')).json();
  const t=u.total;
  document.getElementById('tok').textContent=fT(t.inputTokens+t.outputTokens);
  document.getElementById('cu').textContent=fS(t.computeMs);
  document.getElementById('cost').textContent=fC(t.costUsd);
  document.getElementById('calls').textContent=t.calls;
  document.getElementById('sub').textContent='更新于 '+(u.updatedAt||'—')+' · 每 3 分钟自动刷新';
  const pb=document.querySelector('#prov tbody');pb.innerHTML='';
  for(const [name,x] of Object.entries(u.byProvider||{})){
   const tr=document.createElement('tr');
   tr.innerHTML='<td>'+name+'</td><td class="num">'+fT(x.inputTokens)+'</td><td class="num">'+fT(x.outputTokens)+'</td><td class="num">'+fS(x.computeMs)+'</td><td class="num">'+fC(x.costUsd)+'</td><td class="num">'+x.calls+'</td>';
   pb.appendChild(tr);
  }
  if(!Object.keys(u.byProvider||{}).length)pb.innerHTML='<tr><td colspan=6 class=dim>还没有用量记录，跑一次 run 就有了</td></tr>';
  const s=await (await fetch('/api/status')).json();
  const jb=document.querySelector('#jobs tbody');jb.innerHTML='';
  for(const j of s.jobs||[]){
   for(const tk of j.tasks){
    const tr=document.createElement('tr');
    tr.innerHTML='<td class=dim>'+j.id+'</td><td><span class="badge '+tk.status+'">'+tk.status+'</span> '+tk.title+'</td><td class="num">'+j.done+'/'+j.total+'</td>';
    jb.appendChild(tr);
   }
  }
  if(!(s.jobs||[]).length)jb.innerHTML='<tr><td colspan=3 class=dim>watchDirs 下暂无 job</td></tr>';
 }catch(e){document.getElementById('sub').textContent='加载失败：'+e}
}
load();setInterval(load,180000);
</script></div></body></html>`;

export async function startDashboard(port: number): Promise<void> {
  const config = await loadConfig();

  const server = createServer(async (req, res) => {
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
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
