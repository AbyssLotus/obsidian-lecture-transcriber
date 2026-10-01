const fs=require('fs'),path=require('path');
const M=require('../src/main.js'); const {TFile}=require('obsidian');
const V=process.env.VAULT;
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
const i=code.indexOf('function noteDate(');
const j=code.indexOf('\n}\n', code.indexOf('return out;', code.indexOf('function transcriptsIn')))+3;
const H=new Function(code.slice(i,j)+'; return {noteDate, ymd, transcriptsIn};')();

const p=Object.create(M.prototype);
p.cancelRequested=false; p.activeReq=null;
p.settings={ollamaUrl:'http://localhost:11434',ollamaModel:process.env.SUM_MODEL,ollamaTimeoutMin:30,
  maxContext:16384,deepThinking:false,mathNotation:true,studyUseOwnKnowledge:true,
  studyNotesFolder:'',summaryExtra:''};
for (const k of ['nodeRequest','ollamaGenerate','ollamaVersion','contextFor','maxWordsPerCall','chunkWords',
                 'buildStudyNotes','parseStudyNotes','writeStudyNotes','normalizeMath','outputReserve'])p[k]=M.prototype[k];

const created=new Map();
p.app={vault:{getAbstractFileByPath:x=>created.has(x)?{path:x}:null,
  create:async(x,c)=>{created.set(x,c);return {path:x};}}};
global.window={};

(async()=>{
  const folder=process.env.FOLDER;
  const files=fs.readdirSync(path.join(V,folder)).filter(f=>f.endsWith('.md'));
  const notes=[];
  for (const name of files) {
    const content=fs.readFileSync(path.join(V,folder,name),'utf8');
    const parts=H.transcriptsIn(content);
    if (!parts.length) continue;
    const tf=new TFile(`${folder}/${name}`);
    tf.stat={ctime:fs.statSync(path.join(V,folder,name)).mtimeMs};
    const words=parts.reduce((n,x)=>n+x.text.split(/\s+/).length,0);
    notes.push({file:tf,date:H.noteDate(tf),words,parts});
  }
  notes.sort((a,b)=>a.date-b.date);
  const pick=notes.filter(n=>n.date>=new Date(2026,8,28));   // "this week"
  console.log(`folder: ${folder}`);
  for (const n of pick) console.log(`  using ${H.ymd(n.date)}  ${n.words} words  ${n.file.basename}`);
  const t0=Date.now();
  const digest=await p.buildStudyNotes(pick,(ph)=>console.log('   ·',ph));
  const target=await p.writeStudyNotes(pick,digest,`${folder.split('/').pop()} week test`);
  console.log(`\n(${((Date.now()-t0)/1000).toFixed(0)}s)\n`);
  console.log(created.get(target));
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
