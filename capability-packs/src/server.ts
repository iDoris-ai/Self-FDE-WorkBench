import { createServer } from "node:http";
import { loadPacks } from "./registry.js";
import { accountStatus, saveAccount } from "./accounts.js";
import { invoke } from "./invoke.js";

const PORT = Number(process.env.CAP_PORT ?? 4141);

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Capability Packs</title><style>
:root{--bg:#0e1116;--panel:#161b22;--b:#2b333f;--tx:#e6edf3;--mut:#8b98a9;--acc:#4f9dff;--grn:#3fb950;--amb:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,"PingFang SC",sans-serif;font-size:14px}
.wrap{max-width:860px;margin:0 auto;padding:24px}h1{font-size:19px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:20px}
h2{font-size:14px;color:var(--mut);margin:26px 0 10px;text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--panel);border:1px solid var(--b);border-radius:10px;padding:14px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.badge{padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--b)}
.ok{color:var(--grn);border-color:var(--grn)}.no{color:var(--amb);border-color:var(--amb)}
.cat{font-size:11px;color:var(--mut);text-transform:uppercase}
.desc{color:var(--mut);font-size:12.5px;margin-top:4px}
label{display:block;font-size:12px;color:var(--mut);margin:8px 0 3px}
input,textarea{width:100%;background:var(--bg);color:var(--tx);border:1px solid var(--b);border-radius:7px;padding:8px 10px;font:inherit}
button{font:inherit;cursor:pointer;border:1px solid var(--b);background:#1c2330;color:var(--tx);border-radius:8px;padding:7px 13px}
button:hover{border-color:var(--acc)}button.p{background:var(--acc);border-color:var(--acc);color:#041225;font-weight:600}
.note{color:var(--mut);font-size:11.5px;margin-top:6px;line-height:1.5}
.msg{font-size:12px;margin-top:8px}.msg.ok{color:var(--grn)}.msg.err{color:var(--amb)}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:var(--mut);margin-top:6px;max-height:160px;overflow:auto}
</style></head><body><div class="wrap">
<h1>Capability Packs</h1><div class="sub">能力包 · 账号配置在本机(127.0.0.1)，凭证只存本地 accounts/（不入库）</div>
<h2>能力包</h2><div id="packs"></div>
<h2>账号配置</h2><div id="accounts"></div>
<h2>试生成一张插画（无需账号）</h2>
<div class="card"><label>画面描述（英文更佳）</label>
<textarea id="genp" rows="2">minimalist black ink line art, white background, a cartoon fox reading a book, red scarf</textarea>
<div style="margin-top:8px"><button class="p" onclick="gen()">生成</button></div>
<div id="genmsg" class="msg"></div><div id="genout" class="mono"></div></div>
<script>
async function load(){
 const packs=await (await fetch('/api/packs')).json();
 document.getElementById('packs').innerHTML=packs.map(p=>{
  const auth=p.needsAuth.length?('需账号：'+p.needsAuth.join('、')):'无需账号';
  return '<div class="card"><div class="row"><div><span class="cat">'+p.category+'</span> <b>'+p.name+'</b></div><span class="badge">'+auth+'</span></div><div class="desc">'+p.description+'</div></div>'
 }).join('');
 const accs=await (await fetch('/api/accounts')).json();
 document.getElementById('accounts').innerHTML=accs.map(a=>{
  const fields=a.fields.map(f=>'<label>'+f.label+'</label><input data-p="'+a.id+'" data-k="'+f.key+'" type="'+(f.secret?'password':'text')+'" placeholder="'+(f.value||'')+'" '+(f.value&&!f.secret?'value="'+f.value+'"':'')+'>').join('');
  return '<div class="card"><div class="row"><b>'+a.name+'</b><span class="badge '+(a.configured?'ok':'no')+'">'+(a.configured?'已配置':'未配置')+'</span></div>'+
   (a.note?'<div class="note">'+a.note+'</div>':'')+fields+
   '<div style="margin-top:10px"><button onclick="save(\\''+a.id+'\\')">保存</button><span id="m-'+a.id+'" class="msg"></span></div></div>'
 }).join('');
}
async function save(id){
 const vals={};document.querySelectorAll('[data-p="'+id+'"]').forEach(i=>{if(i.value)vals[i.getAttribute('data-k')]=i.value});
 const r=await fetch('/api/accounts/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(vals)});
 const m=document.getElementById('m-'+id);const j=await r.json();
 m.className='msg '+(r.ok?'ok':'err');m.textContent=r.ok?' ✓ 已保存':' '+(j.error||'失败');
 if(r.ok)setTimeout(load,600);
}
async function gen(){
 const p=document.getElementById('genp').value;const msg=document.getElementById('genmsg');const out=document.getElementById('genout');
 msg.className='msg';msg.textContent='生成中…（本地 FLUX，约 1–2 分钟）';out.textContent='';
 const r=await fetch('/api/invoke/generate-illustration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p})});
 const j=await r.json();msg.className='msg '+(j.ok?'ok':'err');msg.textContent=j.message;out.textContent=j.output||'';
}
load();
</script></div></body></html>`;

async function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const json = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url === "/api/packs") return json(200, await loadPacks());
    if (url === "/api/accounts") return json(200, await accountStatus());
    if (url.startsWith("/api/accounts/") && req.method === "POST") {
      const id = url.slice("/api/accounts/".length);
      await saveAccount(id, await body(req));
      return json(200, { ok: true });
    }
    if (url.startsWith("/api/invoke/") && req.method === "POST") {
      const id = url.slice("/api/invoke/".length);
      const input = await body(req);
      const strInput: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) strInput[k] = String(v);
      return json(200, await invoke(id, strInput));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } catch (e) {
    json(500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`Capability Packs 网页：http://127.0.0.1:${PORT}`);
});
