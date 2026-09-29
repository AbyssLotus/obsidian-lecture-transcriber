const fs=require('fs');
const M=require('../src/main.js');
const p=Object.create(M.prototype);
p.cancelRequested=false;p.activeReq=null;
p.settings=JSON.parse(fs.readFileSync(process.env.DATA,'utf8'));
for(const k of ['nodeRequest','ollamaGenerate','contextFor','maxWordsPerCall','chunkWords','parseSummary','summarise','normalizeMath'])p[k]=M.prototype[k];
const text=fs.readFileSync(process.env.TXT,'utf8');
(async()=>{
  console.log('words:',text.split(/\s+/).length,' ctx:',p.contextFor(text),' maxWordsPerCall:',p.maxWordsPerCall());
  const t0=Date.now();
  try{
    const r=await p.summarise(text,(ph)=>console.log('  phase:',ph));
    console.log(`OK in ${((Date.now()-t0)/1000).toFixed(0)}s title=${JSON.stringify(r.title)} points=${r.points.length}`);
  }catch(e){
    console.log(`FAILED in ${((Date.now()-t0)/1000).toFixed(0)}s: ${e.message}`);
    // show what the model actually sent back
    const raw=await p.ollamaGenerate('Below is the content of one class session.\n\nRespond in EXACTLY this format, with no preamble:\n\nTITLE: <a short specific title>\nSUMMARY:\n<3-5 sentences>\nKEYPOINTS:\n- <5 to 9 bullets>\n\nCONTENT:\n'+text,'You summarise university lecture transcripts.');
    console.log('--- RAW RESPONSE ('+raw.length+' chars) ---');
    console.log(JSON.stringify(raw.slice(0,900)));
  }
})();
