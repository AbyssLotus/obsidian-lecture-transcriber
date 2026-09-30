const fs=require('fs'),path=require('path');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
const i=code.indexOf('const MODEL_BASE');
const j=code.indexOf('\n}\n', code.indexOf('function modelUrl'))+3;
const { modelUrl, MODEL_BASE, VAD_BASE } =
  new Function(code.slice(i,j)+'; return {modelUrl, MODEL_BASE, VAD_BASE};')();

// Every filename the wizard can ask for, taken from the module itself.
const names=[...new Set([
  ...(code.match(/'ggml-[a-z0-9.\-_]+\.bin'/gi)||[]).map(s=>s.replace(/'/g,'')),
])];

console.log('\n--- model URLs are routed to the right repository ---');
{
  ok('the two bases are different', MODEL_BASE!==VAD_BASE);
  ok('silence model goes to the VAD repo', modelUrl('ggml-silero-v5.1.2.bin').startsWith(VAD_BASE),
     modelUrl('ggml-silero-v5.1.2.bin'));
  ok('speech models go to the whisper.cpp repo', modelUrl('ggml-large-v3-q5_0.bin').startsWith(MODEL_BASE));
  ok('turbo model goes to the whisper.cpp repo', modelUrl('ggml-large-v3-turbo-q5_0.bin').startsWith(MODEL_BASE));
  ok('found the model names in the source', names.length>=3, names.join(', '));
}

console.log('\n--- live check (set LIVE=1 to hit the network) ---');
(async()=>{
  if (process.env.LIVE!=='1') { console.log('  SKIP  (LIVE not set)'); }
  else {
    const https=require('https');
    const head=(u)=>new Promise(r=>{
      const go=(url,n)=>{ if(n>5) return r(0);
        https.request(url,{method:'HEAD'},res=>{
          if(res.statusCode>=300&&res.statusCode<400&&res.headers.location) return go(new URL(res.headers.location,url).toString(),n+1);
          r(res.statusCode);
        }).on('error',()=>r(0)).end(); };
      go(u,0);
    });
    for (const n of names) {
      const u=modelUrl(n), c=await head(u);
      ok(`${n} resolves`, c===200, `HTTP ${c} ${u}`);
    }
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail?1:0);
})();
