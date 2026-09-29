const http=require('http');
const M=require('../src/main.js');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const mk=(url)=>{const p=Object.create(M.prototype);p.cancelRequested=false;p.activeReq=null;
  p.settings={ollamaUrl:url,ollamaModel:'',ollamaTimeoutMin:20,maxContext:16384,summarize:true};
  p._saved=false; p.saveSettings=async()=>{p._saved=true;};
  for(const k of ['nodeRequest','ollamaVersion','ollamaModels','ollamaPull','adoptInstalledModel','contextFor'])p[k]=M.prototype[k];
  return p;};

(async()=>{
// fake ollama
let pullBehaviour='ok';
const srv=http.createServer((req,res)=>{
  if(req.url==='/api/version'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"version":"0.34.0"}');return;}
  if(req.url==='/api/tags'){res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({models:[
      {name:'tiny:0.5b',size:400e6},
      {name:'aaa-huge:70b',size:40e9},
      {name:'qwen3:4b',size:2.6e9},
      {name:'llama3.2:3b',size:2.0e9}]}));return;}
  if(req.url==='/api/pull'){
    res.writeHead(200,{'Content-Type':'application/x-ndjson'});
    if(pullBehaviour==='error'){ res.end(JSON.stringify({error:'pull model manifest: file does not exist'})+'\n'); return; }
    // stream a couple of progress lines, then finish — split mid-line on purpose
    res.write('{"status":"pulling","completed":50,"total":100}\n{"status":"pull');
    setTimeout(()=>{ res.write('ing","completed":100,"total":100}\n'); res.end(); },30);
    return;
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${srv.address().port}`;

console.log('\n--- detecting Ollama ---');
{
  const p=mk(base);
  ok('reports the version when running', await p.ollamaVersion()==='0.34.0');
  const dead=mk('http://127.0.0.1:1');
  ok('empty string when nothing is listening', await dead.ollamaVersion()==='');
  ok('lists installed models', (await p.ollamaModels()).length===4);
}

console.log('\n--- adopting a model so summaries do not just fail ---');
{
  const p=mk(base);
  ok('picks the smallest sensible model, not the alphabetical or biggest one',
     await p.adoptInstalledModel()===true && p.settings.ollamaModel==='llama3.2:3b', p.settings.ollamaModel);
  ok('saved the choice', p._saved===true);

  const keep=mk(base); keep.settings.ollamaModel='llama3.2:3b';
  await keep.adoptInstalledModel();
  ok('keeps a valid existing choice', keep.settings.ollamaModel==='llama3.2:3b');

  const stale=mk(base); stale.settings.ollamaModel='gone:1b';
  await stale.adoptInstalledModel();
  ok('replaces a model that is gone', stale.settings.ollamaModel==='llama3.2:3b', stale.settings.ollamaModel);

  const none=mk('http://127.0.0.1:1');
  ok('false when Ollama is unreachable', await none.adoptInstalledModel()===false);
  ok('never picks a tiny model when a usable one exists', p.settings.ollamaModel!=='tiny:0.5b');
}

console.log('\n--- pulling a model with progress ---');
{
  const p=mk(base);
  const seen=[];
  await p.ollamaPull('qwen3:4b',(status,done,total)=>seen.push(`${status} ${done}/${total}`));
  ok('reported progress', seen.length===2, JSON.stringify(seen));
  ok('reassembled a line split across chunks', seen[1]==='pulling 100/100', seen[1]);
  ok('cleared the in-flight handle', p.activeReq===null);

  pullBehaviour='error';
  let msg=''; try{ await p.ollamaPull('nope:1b',()=>{}); }catch(e){ msg=e.message; }
  ok('surfaces a bad model name', msg.includes('file does not exist'), msg);
  pullBehaviour='ok';

  const dead=mk('http://127.0.0.1:1');
  msg=''; try{ await dead.ollamaPull('x',()=>{}); }catch(e){ msg=e.message; }
  ok('explains an unreachable server', msg.includes('Could not reach Ollama'), msg);
}

srv.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
