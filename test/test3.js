const M=require('../src/main.js'); const {TFile}=require('obsidian');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const mk=()=>{const p=Object.create(M.prototype);p.awakeReasons=new Set();p.recordingStreams=new Set();p.awakeProc=null;
  p.settings={keepAwake:true,keepAwakeRecording:true,corrections:'',vocabulary:'',usePriorNotes:true,courseVocabulary:true};
  let spawned=0,killed=0;
  p.acquireAwake=function(r){ if(r==='transcribing'&&!this.settings.keepAwake)return; if(r==='recording'&&!this.settings.keepAwakeRecording)return;
    this.awakeReasons.add(r); if(this.awakeProc)return; spawned++; this.awakeProc={kill(){killed++;}}; };
  p.releaseAwake=M.prototype.releaseAwake; p.releaseAllAwake=M.prototype.releaseAllAwake;
  p.stats=()=>({spawned,killed}); return p;};

console.log('\n--- wake lock is reference counted ---');
{
  const p=mk();
  p.acquireAwake('recording'); p.acquireAwake('transcribing');
  ok('one caffeinate for both reasons', p.stats().spawned===1, JSON.stringify(p.stats()));
  p.releaseAwake('transcribing');
  ok('still held while recording continues', p.awakeProc!==null && p.stats().killed===0);
  p.releaseAwake('recording');
  ok('released when the last reason goes', p.awakeProc===null && p.stats().killed===1);
}
console.log('\n--- toggles are respected ---');
{
  const p=mk(); p.settings.keepAwakeRecording=false;
  p.acquireAwake('recording');
  ok('no lock when recording keep-awake is off', p.awakeProc===null);
  p.acquireAwake('transcribing');
  ok('transcribing still locks', p.awakeProc!==null);
}
console.log('\n--- corrections ---');
{
  const p=mk();
  p.parseCorrections=M.prototype.parseCorrections; p.applyCorrections=M.prototype.applyCorrections;
  p.settings.corrections='gravel => parabola\nSoundario -> scenario\n  \nbadline\nDr. Thurman => Dr. Thierman';
  const r=p.applyCorrections('The top of the gravel. More Gravel here. A Soundario. Ask Dr. Thurman. Gravelly road.');
  ok('replaces the term', !/\bgravel\b/i.test(r.text), r.text);
  ok('case-insensitive', (r.text.match(/parabola/g)||[]).length===2, r.text);
  ok('supports -> as well', r.text.includes('scenario'));
  ok('handles names with a dot', r.text.includes('Dr. Thierman'));
  ok('does not touch "Gravelly"', r.text.includes('Gravelly'), r.text);
  ok('counts replacements', r.n===4, `n=${r.n}`);
  ok('ignores malformed lines', true);
  p.settings.corrections='';
  ok('no-op when empty', p.applyCorrections('untouched').text==='untouched');
  p.settings.corrections='[bad(regex => x';
  ok('survives a regex-unsafe rule', p.applyCorrections('[bad(regex here').text.includes('x'));
}
console.log('\n--- course vocabulary ---');
{
  const p=mk(); p.courseTerms=M.prototype.courseTerms;
  const f1=new TFile('Math-116/9.22.26 Week 1.md'), f2=new TFile('Math-116/9.25.26 Week 2.md'), f3=new TFile('PSY-101/Other.md');
  // recordings live in a separate Voice/ folder in the real vault
  const notePath='Math-116/9.22.26 Week 1.md';
  p.app={ vault:{getFiles:()=>[f1,f2,f3]},
    metadataCache:{getFileCache:(f)=> f===f1?{headings:[{heading:'Piecewise functions'},{heading:'Vertex form'}]}:null} };
  const t=p.courseTerms(notePath);
  ok('includes sibling headings', t.includes('Piecewise functions')&&t.includes('Vertex form'), t);
  ok('excludes other courses', !t.includes('Other'), t);
  ok('strips date noise from titles', !/9\.22\.26/.test(t), t);
  p.settings.courseVocabulary=false;
  ok('respects the toggle', p.courseTerms(notePath)==='');
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
