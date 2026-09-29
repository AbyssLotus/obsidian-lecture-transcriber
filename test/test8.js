const M=require('../src/main.js'); const {TFile}=require('obsidian');
// nodeRequest replaces requestUrl; stub it the same way
let __resp=null; const requestUrl={__set:(r)=>{__resp=r;}};
const stubNet=(p)=>{ p.nodeRequest=async(m,u,body)=>{
  const r=(typeof __resp==='function')?__resp({url:u,body}):__resp;
  if(!r) throw new Error('no stub set');
  return {status:r.status, body:JSON.stringify(r.json||{})}; }; };
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const mk=()=>{const p=Object.create(M.prototype);p.cancelRequested=false;
  p.settings={mathNotation:true,mathInTranscript:false,mathModel:'',ollamaModel:'m',ollamaUrl:'http://x',
              headingLabel:'Transcript',modelPath:'/x/ggml-large-v3.bin',summarize:true,summaryExtra:''};
  for(const k of ['normalizeMath','escapeDollars','chunkParagraphs','markupMath','ollamaGenerate','writeTranscript','targetNoteFor','parseSummary'])p[k]=M.prototype[k]; stubNet(p);
  return p;};

(async()=>{
console.log('\n--- delimiters Obsidian cannot render ---');
{
  const p=mk();
  ok('\\( \\) becomes $ $', p.normalizeMath('so \\(x^2 + 1\\) holds')==='so $x^2 + 1$ holds', p.normalizeMath('so \\(x^2 + 1\\) holds'));
  ok('\\[ \\] becomes $$ $$', p.normalizeMath('\\[ x = -b/2a \\]')==='$$x = -b/2a$$', p.normalizeMath('\\[ x = -b/2a \\]'));
  ok('math code fence unwrapped', p.normalizeMath('```math\nE = mc^2\n```')==='$$E = mc^2$$', JSON.stringify(p.normalizeMath('```math\nE = mc^2\n```')));
  ok('latex fence unwrapped', p.normalizeMath('```latex\na+b\n```').includes('$$a+b$$'));
  ok('equation env unwrapped', p.normalizeMath('\\begin{equation}y=mx+b\\end{equation}')==='$$y=mx+b$$', p.normalizeMath('\\begin{equation}y=mx+b\\end{equation}'));
  ok('align env unwrapped', p.normalizeMath('\\begin{align}a=b\\end{align}')==='$$a=b$$');
  ok('already-correct maths untouched', p.normalizeMath('inline $x^2$ and $$y=1$$')==='inline $x^2$ and $$y=1$$');
  ok('plain prose untouched', p.normalizeMath('no maths here at all')==='no maths here at all');
  ok('empty safe', p.normalizeMath('')==='' && p.normalizeMath(null)===null);
}
console.log('\n--- key points stay on one line ---');
{
  const p=mk();
  const r=p.normalizeMath('Use $$x = -\\frac{b}{2a}$$ to find it', true);
  ok('display maths collapsed to inline', r==='Use $x = -\\frac{b}{2a}$ to find it', r);
  const multi=p.normalizeMath('Vertex:\n$$\nx = -b/2a\n$$', true);
  ok('multiline display collapsed', !multi.includes('$$') && multi.includes('$x = -b/2a$'), JSON.stringify(multi));
  const blk=p.normalizeMath('Vertex:\n$$\nx = -b/2a\n$$', false);
  ok('summary keeps display maths', blk.includes('$$'), JSON.stringify(blk));
}
console.log('\n--- stray dollars in a plain transcript ---');
{
  const p=mk();
  ok('escapes currency', p.escapeDollars('it cost $5 and then $10')==='it cost \\$5 and then \\$10', p.escapeDollars('it cost $5 and then $10'));
  ok('no dollars is a no-op', p.escapeDollars('nothing here')==='nothing here');
}
console.log('\n--- transcript body escaping is conditional ---');
{
  const mkNote=async(info)=>{ const p=mk(); const notes=new Map();
    const audio=new TFile('Voice/L.m4a'), note=new TFile('M/W1.md'); notes.set(note.path,'Notes.\n');
    p.app={metadataCache:{resolvedLinks:{'M/W1.md':{'Voice/L.m4a':1}}},
      vault:{getAbstractFileByPath:x=>x===note.path?note:null,read:async f=>notes.get(f.path),
        modify:async(f,c)=>notes.set(f.path,c),process:async(f,fn)=>{const v=fn(notes.get(f.path));notes.set(f.path,v);return v;},create:async()=>{throw new Error('no');}}};
    global.window={};
    await p.writeTranscript(audio,'price was $5 and $10',info); return notes.get(note.path); };
  ok('plain transcript escapes dollars', (await mkNote({})).includes('\\$5'));
  ok('marked-up transcript keeps maths', (await mkNote({mathInfo:{converted:2,chunks:2}})).includes('$5'));
}
console.log('\n--- paragraph chunking keeps boundaries ---');
{
  const p=mk();
  const text=['a '.repeat(300).trim(),'b '.repeat(300).trim(),'c '.repeat(50).trim()].join('\n\n');
  const c=p.chunkParagraphs(text,400);
  ok('splits on paragraph boundaries', c.length===2, `chunks=${c.length}`);
  ok('never splits mid-paragraph', c.every(x=>!/a b|b c/.test(x)));
  ok('short text stays whole', p.chunkParagraphs('one two three',400).length===1);
}
console.log('\n--- transcript rewrite is guarded ---');
{
  const p=mk();
  const text='three x minus eight equals zero. '.repeat(40).trim();
  requestUrl.__set({status:200,json:{response:'$3x - 8 = 0$. '.repeat(40).trim()}});
  let r=await p.markupMath(text,()=>{});
  ok('accepts a same-length rewrite', r.converted===r.chunks && r.text.includes('$3x - 8 = 0$'), JSON.stringify({c:r.converted,n:r.chunks}));

  requestUrl.__set({status:200,json:{response:'Here is a summary of the maths.'}});
  r=await p.markupMath(text,()=>{});
  ok('rejects a shrunken rewrite', r.converted===0 && r.text===text, `converted=${r.converted}`);

  requestUrl.__set({status:500,json:{}});
  r=await p.markupMath(text,()=>{});
  ok('survives an Ollama error', r.converted===0 && r.text===text);
  requestUrl.__set(null);
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
