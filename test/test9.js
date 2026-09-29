const http=require('http');
const M=require('../src/main.js');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const mk=(port)=>{const p=Object.create(M.prototype);p.cancelRequested=false;p.activeReq=null;
  p.settings={ollamaUrl:`http://127.0.0.1:${port}`,ollamaModel:'m',maxContext:16384,ollamaTimeoutMin:20,
              summaryExtra:'',mathNotation:false,summarize:true};
  for(const k of ['nodeRequest','ollamaGenerate','ollamaModels','contextFor','maxWordsPerCall','chunkWords','parseSummary','summarise','normalizeMath'])p[k]=M.prototype[k];
  return p;};
const GOOD='TITLE: T\nSUMMARY:\nS.\nKEYPOINTS:\n- A real key point';

(async()=>{
// --- a server that fails once, then succeeds ---
let hits=0;
const srv=http.createServer((req,res)=>{
  hits++;
  if(req.url==='/api/tags'){ res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({models:[{name:'a:1'},{name:'b:2'}]})); return; }
  if(req.url==='/flaky' && hits<3){ req.destroy(); return; }          // transient
  if(req.url==='/api/generate'){ res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({response:GOOD})); return; }
  if(req.url==='/bad'){ res.writeHead(500); res.end('nope'); return; }
  if(req.url==='/garbage'){ res.writeHead(200); res.end('not json at all'); return; }
  if(req.url==='/slow'){ setTimeout(()=>{res.writeHead(200);res.end('{}');},5000); return; }
  res.writeHead(404); res.end();
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const port=srv.address().port;

console.log('\n--- real requests over node http (not chromium) ---');
{
  const p=mk(port);
  const models=await p.ollamaModels();
  ok('lists models', models.join(',')==='a:1,b:2', models.join(','));
  const out=await p.ollamaGenerate('hello','sys');
  ok('generate returns the response', out.includes('TITLE: T'), out.slice(0,40));
  ok('clears the in-flight handle', p.activeReq===null);
}

console.log('\n--- errors are reported usefully ---');
{
  let p=mk(port); p.settings.ollamaUrl=`http://127.0.0.1:${port}/bad`;
  // route /bad through the generate path
  p.nodeRequest=async()=>({status:500,body:'nope'});
  let msg=''; try{ await p.ollamaGenerate('x','y'); }catch(e){ msg=e.message; }
  ok('http 500 explained', msg.includes('500')&&msg.includes('"m"'), msg);

  p=mk(port); p.nodeRequest=async()=>({status:200,body:'not json at all'});
  msg=''; try{ await p.ollamaGenerate('x','y'); }catch(e){ msg=e.message; }
  ok('unparseable body explained', msg.includes('could not be read'), msg);

  p=mk(1);   // nothing listening
  msg=''; try{ await p.ollamaGenerate('x','y'); }catch(e){ msg=e.message; }
  ok('unreachable names the address', msg.includes('Could not reach Ollama')&&msg.includes('127.0.0.1:1'), msg);
}

console.log('\n--- one retry covers a transient drop ---');
{
  const p=mk(port);
  let n=0;
  const realOnce=p.nodeRequest.bind(p);
  p.nodeRequest=async(m,u,b)=>{ n++; if(n===1) throw new Error('socket hang up'); return realOnce(m,u,b); };
  const out=await p.ollamaGenerate('hello','sys');
  ok('retried and succeeded', n===2 && out.includes('TITLE: T'), `attempts=${n}`);

  const p2=mk(port); let n2=0;
  p2.nodeRequest=async()=>{ n2++; throw new Error('socket hang up'); };
  let msg=''; try{ await p2.ollamaGenerate('x','y'); }catch(e){ msg=e.message; }
  ok('gives up after two attempts', n2===2 && msg.includes('socket hang up'), `attempts=${n2}`);
}

console.log('\n--- timeout floor, and aborting a request in flight ---');
{
  // The setting is in minutes and is clamped to a 1-minute floor, so a hung
  // request cannot be abandoned after a couple of seconds by accident.
  const p=mk(port);
  p.settings.ollamaTimeoutMin=1/60;
  const t0=Date.now();
  const r=await p.nodeRequest('GET',`http://127.0.0.1:${port}/slow`,null);
  ok('sub-minute timeout is clamped, not applied', r.status===200 && Date.now()-t0>4000, `${Date.now()-t0}ms`);

  // The path that actually matters in use: Cancel destroys the in-flight request.
  const p2=mk(port);
  const pending=p2.nodeRequest('GET',`http://127.0.0.1:${port}/slow`,null);
  await new Promise(r=>setTimeout(r,300));
  ok('exposes the in-flight request for cancelling', p2.activeReq!==null);
  p2.activeReq.destroy();
  let msg=''; const t1=Date.now();
  try{ await pending; }catch(e){ msg=e.message; }
  ok('destroying it rejects promptly', msg.length>0 && Date.now()-t1<2000, `${Date.now()-t1}ms ${msg}`);
}

console.log('\n--- cancelling stops it making more calls ---');
{
  const p=mk(port); let n=0;
  p.nodeRequest=async()=>{ n++; p.cancelRequested=true; throw new Error('boom'); };
  let threw=''; try{ await p.ollamaGenerate('x','y'); }catch(e){ threw=e.name||e.message; }
  ok('does not retry after cancel', n===1, `attempts=${n}`);
  ok('reports cancellation', threw==='Cancelled', threw);
}

srv.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
