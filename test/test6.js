const M=require('../src/main.js'); const {TFile}=require('obsidian');
// nodeRequest replaces requestUrl; stub it the same way
let __resp=null; const requestUrl={__set:(r)=>{__resp=r;}};
const stubNet=(p)=>{ p.nodeRequest=async(m,u,body)=>{
  const r=(typeof __resp==='function')?__resp({url:u,body}):__resp;
  if(!r) throw new Error('no stub set');
  return {status:r.status, body:JSON.stringify(r.json||{})}; }; };
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const mk=()=>{const p=Object.create(M.prototype);p.cancelRequested=false;
  p.settings={summarize:true,ollamaUrl:'http://localhost:11434/',ollamaModel:'m',summaryExtra:'',headingLabel:'Transcript',modelPath:'/x/ggml-large-v3-q5_0.bin',maxContext:16384,mathNotation:false};
  for(const k of ['ollamaGenerate','ollamaModels','chunkWords','parseSummary','summarise','writeTranscript','targetNoteFor','contextFor','maxWordsPerCall'])p[k]=M.prototype[k]; stubNet(p);
  return p;};

(async()=>{
console.log('\n--- parsing the model output ---');
{
  const p=mk();
  const r=p.parseSummary('TITLE: Piecewise Functions\nSUMMARY:\nLine one.\nLine two.\nKEYPOINTS:\n- First point\n* Second point\n• Third point\n');
  ok('title', r.title==='Piecewise Functions', r.title);
  ok('summary keeps both lines', r.summary==='Line one.\nLine two.', JSON.stringify(r.summary));
  ok('bullets in 3 styles', r.points.length===3 && r.points[2]==='Third point', JSON.stringify(r.points));
  const q=p.parseSummary('<think>hmm let me consider</think>\nTITLE: T\nSUMMARY:\nS.\nKEYPOINTS:\n- A real key point');
  ok('tolerates leading noise', q.title==='T' && q.points[0]==='A real key point', JSON.stringify(q));
  const nk=p.parseSummary('TITLE: A\nSUMMARY:\nSummary with no key points section.');
  ok('keeps summary when KEYPOINTS is absent', nk.summary.includes('no key points'), JSON.stringify(nk));
  const bare=p.parseSummary('no structure at all');
  ok('degrades safely', bare.title===''&&bare.points.length===0);
}
console.log('\n--- thinking tags are stripped ---');
{
  const p=mk();
  requestUrl.__set({status:200,json:{response:'<think>secret reasoning</think>TITLE: X\nSUMMARY:\nY.\nKEYPOINTS:\n- Z'}});
  const out=await p.ollamaGenerate('x','y');
  ok('no think block', !out.includes('secret reasoning'), out);
}
console.log('\n--- errors are explained, not swallowed ---');
{
  const p=mk();
  requestUrl.__set({status:404,json:{}});
  let msg=''; try{ await p.ollamaGenerate('x','y'); }catch(e){ msg=e.message; }
  ok('mentions status and model', msg.includes('404')&&msg.includes('"m"'), msg);
}
console.log('\n--- chunking long lectures ---');
{
  const p=mk();
  const words=Array.from({length:5000},(_,i)=>'w'+i).join(' ');
  const c=p.chunkWords(words,2000,120);
  ok('splits a long transcript', c.length>1, `chunks=${c.length}`);
  ok('chunks overlap', c[0].split(' ').slice(-120)[0]===c[1].split(' ')[0]);
  ok('short text stays whole', p.chunkWords('a b c',2000,120).length===1);
  ok('covers the tail', c[c.length-1].endsWith('w4999'));
}
console.log('\n--- one call when it fits, map-reduce only when it does not ---');
{
  const FINAL='TITLE: Final\nSUMMARY:\nAll of it.\nKEYPOINTS:\n- A real key point here\n- Another real one';
  // medium lecture: must be a single call now
  let p=mk(); let calls=0;
  requestUrl.__set(()=>{ calls++; return {status:200,json:{response:FINAL}}; });
  const medium=Array.from({length:3000},(_,i)=>'w'+i).join(' ');
  let phases=[]; let r=await p.summarise(medium,(ph)=>phases.push(ph));
  ok('3000 words is one call', calls===1, `calls=${calls}`);
  ok('no map phase reported', !phases.some(x=>x.startsWith('summarising')), phases.join(','));
  ok('title parsed', r.title==='Final');

  // very long lecture: falls back to map-reduce
  p=mk(); calls=0;
  requestUrl.__set(()=>{ calls++;
    return {status:200,json:{response: calls<=3 ? '- partial bullet from this part' : FINAL}}; });
  const huge=Array.from({length:25000},(_,i)=>'w'+i).join(' ');
  phases=[]; r=await p.summarise(huge,(ph)=>phases.push(ph));
  ok('very long lecture is chunked', calls>2, `calls=${calls}`);
  ok('mapped then reduced', phases.some(x=>x.startsWith('summarising'))&&phases.includes('writing summary'), phases.join(','));
  ok('final answer used', r.title==='Final'&&r.points.length===2);
  requestUrl.__set(null);
}

console.log('\n--- context window is sized to the text ---');
{
  const p=mk();
  const w=(n)=>'w '.repeat(n).trim();
  // Floor is 8192, not 4096: a 4096 window left too little room for the
  // model's answer and produced unparseable replies.
  ok('never drops below an 8k window', p.contextFor(w(200))===8192, String(p.contextFor(w(200))));
  ok('medium text stays within the cap', p.contextFor(w(2114))>=8192 && p.contextFor(w(2114))<=16384, String(p.contextFor(w(2114))));
  ok('thinking reserves much more room', (()=>{const a=p.contextFor(w(6000));p.settings.deepThinking=true;const b=p.contextFor(w(6000));p.settings.deepThinking=false;return b>a;})());
  ok('very long text is capped', p.contextFor(w(50000))===16384, String(p.contextFor(w(50000))));
  p.settings.maxContext=8192;
  ok('respects a lower cap', p.contextFor(w(50000))===8192);
  ok('fewer words per call at a lower cap', p.maxWordsPerCall()<5000, String(p.maxWordsPerCall()));
  p.settings.maxContext=16384;
}

console.log('\n--- note layout ---');
{
  const p=mk(); const notes=new Map();
  const audio=new TFile('Voice/L.m4a'), note=new TFile('PSY/Week1.md');
  notes.set(note.path,'My typed notes.\n');
  p.app={metadataCache:{resolvedLinks:{'PSY/Week1.md':{'Voice/L.m4a':1}}},
    vault:{getAbstractFileByPath:x=>x===note.path?note:null,read:async f=>notes.get(f.path),
      modify:async(f,c)=>notes.set(f.path,c),create:async()=>{throw new Error('should not create');}}};
  global.window={};
  await p.writeTranscript(audio,'RAW TEXT.',{digest:{title:'Cognitive Revolution',summary:'It covered X.',points:['One','Two']}});
  const out=notes.get(note.path);
  console.log(out.split('\n').map(l=>'   | '+l).join('\n'));
  ok('h2 is the generated title', out.includes('## Cognitive Revolution'));
  ok('summary section', out.includes('### Summary')&&out.includes('It covered X.'));
  ok('key points as bullets', out.includes('### Key points')&&out.includes('- One'));
  ok('transcript under its own h3', out.includes('### Transcript')&&out.includes('RAW TEXT.'));
  ok('transcript comes last so it folds away', out.indexOf('### Transcript')>out.indexOf('### Key points'));
  ok('user notes preserved', out.startsWith('My typed notes.'));
}
console.log('\n--- a failed summary must not cost the transcript ---');
{
  const p=mk(); const notes=new Map();
  const audio=new TFile('Voice/L.m4a'), note=new TFile('PSY/Week1.md');
  notes.set(note.path,'Notes.\n');
  p.app={metadataCache:{resolvedLinks:{'PSY/Week1.md':{'Voice/L.m4a':1}}},
    vault:{getAbstractFileByPath:x=>x===note.path?note:null,read:async f=>notes.get(f.path),
      modify:async(f,c)=>notes.set(f.path,c),create:async()=>{throw new Error('no');}}};
  await p.writeTranscript(audio,'STILL HERE.',{digestError:'Ollama returned 404'});
  const out=notes.get(note.path);
  ok('transcript still written', out.includes('STILL HERE.'));
  ok('failure is stated in the note', out.includes('Summary unavailable: Ollama returned 404'));
  ok('falls back to a filename heading', out.includes('## Transcript — L.m4a'));
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
