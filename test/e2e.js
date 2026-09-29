const fs=require('fs'),path=require('path');
const M=require('../src/main.js'); const {TFile}=require('obsidian');
const HOME=process.env.HOME;
const p=Object.create(M.prototype);
p.cancelRequested=false;p.activeProc=null;p.awakeReasons=new Set();p.recordingStreams=new Set();
p.settings={ whisperPath:'/opt/homebrew/bin/whisper-cli', ffmpegPath:'/opt/homebrew/bin/ffmpeg',
  modelPath:path.join(HOME,'.local/share/whisper-models/'+(process.env.WMODEL||'ggml-large-v3-q5_0.bin')),
  whisperPath:'/opt/homebrew/bin/whisper-cli',ffmpegPath:'/opt/homebrew/bin/ffmpeg',
  vadModelPath:path.join(HOME,'.local/share/whisper-models/ggml-silero-v5.1.2.bin'),
  language:'en',useVad:true,cleanAudio:true,threads:0,headingLabel:'Transcript',
  vocabulary:'',usePriorNotes:true,courseVocabulary:true,corrections:'',
  summarize:true,ollamaUrl:'http://localhost:11434',ollamaModel:process.env.SUM_MODEL,summaryExtra:'',
  mathNotation:true,mathInTranscript:false,mathModel:'',
  fastDecode:process.env.FAST!=='0',maxContext:parseInt(process.env.CTX||'16384',10) };
const notes=new Map();
const audio=new TFile('Voice/Class.m4a'), note=new TFile('Math-116/Week 1 Class 3.md');
notes.set(note.path,'Piecewise functions!!\n');
p.app={ metadataCache:{resolvedLinks:{'Math-116/Week 1 Class 3.md':{'Voice/Class.m4a':1}},getFileCache:()=>null},
  vault:{ adapter:{readBinary:async()=>fs.readFileSync(process.env.TEST_AUDIO).buffer},
    getAbstractFileByPath:x=>x===note.path?note:(x===audio.path?audio:null),
    getFiles:()=>[note,audio], read:async f=>notes.get(f.path), cachedRead:async f=>notes.get(f.path),
    modify:async(f,c)=>notes.set(f.path,c), create:async(x,c)=>{const f=new TFile(x);notes.set(x,c);return f;} } };
global.window={};
(async()=>{
  const t0=Date.now();
  const phases=[];
  const r=await p.transcribeOne(audio,(ph,pct)=>{const k=ph+(ph==='transcribing'?'':''); if(phases[phases.length-1]!==k)phases.push(k);});
  console.log(`\n(${((Date.now()-t0)/1000).toFixed(0)}s, ${r.words} words, model ${process.env.SUM_MODEL})`);
  console.log('phases:',phases.join(' → '));
  if(r.digestError) console.log('DIGEST ERROR:',r.digestError);
  const out=notes.get(note.path);
  // print everything except the bulk of the transcript
  const i=out.indexOf('### Transcript');
  if(process.env.QUIET) { console.log('title:',(r.digest&&r.digest.title)||'-'); }
  else { console.log('\n======== NOTE ========'); console.log(out.slice(0,i+400).trimEnd()+'\n   …[transcript continues]…'); }
})().catch(e=>{console.error('ERR',e);process.exit(2);});
