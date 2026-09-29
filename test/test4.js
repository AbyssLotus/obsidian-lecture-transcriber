const M=require('../src/main.js');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

// --- fake browser surface ---
const timers=new Set();
global.window={ setInterval:(fn,ms)=>{const id=setInterval(fn,ms);timers.add(id);return id;},
                clearInterval:(id)=>{clearInterval(id);timers.delete(id);} };
function track(){ let st='live'; const ls={};
  return { get readyState(){return st;}, stop(){st='ended';},   // NB: stop() fires no event, by spec
           endWithEvent(){st='ended';(ls['ended']||[]).forEach(f=>f());},
           addEventListener:(e,f)=>{(ls[e]=ls[e]||[]).push(f);} }; }
function stream(t){ return { getAudioTracks:()=>t }; }
// Node >=21 defines a read-only `navigator` global, so plain assignment is a no-op.
function setNavigator(md){ Object.defineProperty(globalThis,'navigator',
  { value:{ mediaDevices: md }, configurable:true, writable:true }); }

function mkPlugin(){
  const p=Object.create(M.prototype);
  p.awakeReasons=new Set(); p.recordingStreams=new Set(); p.awakeProc=null;
  p.settings={keepAwake:true,keepAwakeRecording:true};
  p.statusText=''; p.statusEl={setText:(t)=>{p.statusText=t;}};
  p.registerInterval=()=>{}; p.register=(fn)=>{p._unhook=fn;};
  p.refreshStatus=M.prototype.refreshStatus.bind(p);
  let spawned=0;
  p.acquireAwake=function(r){ if(r==='recording'&&!this.settings.keepAwakeRecording)return;
    this.awakeReasons.add(r); if(this.awakeProc)return; spawned++; this.awakeProc={kill(){}}; };
  p.releaseAwake=M.prototype.releaseAwake;
  p.onRecordingStarted=M.prototype.onRecordingStarted;
  p.hookRecording=M.prototype.hookRecording;
  p.spawned=()=>spawned;
  return p;
}

(async()=>{
console.log('\n--- getUserMedia hook ---');
{
  const t1=track(), s1=stream([t1]);
  setNavigator({ getUserMedia: async()=>s1 });
  const p=mkPlugin(); p.hookRecording();
  ok('wraps getUserMedia', navigator.mediaDevices.__ltHooked===true);
  ok('is idempotent', (()=>{const g=navigator.mediaDevices.getUserMedia;p.hookRecording();return navigator.mediaDevices.getUserMedia===g;})());

  const got=await navigator.mediaDevices.getUserMedia({audio:true});
  ok('returns the caller its stream untouched', got===s1);
  ok('holds the wake lock while recording', p.awakeProc!==null && p.awakeReasons.has('recording'));
  ok('status bar shows recording', p.statusText.includes('recording'), p.statusText);

  t1.stop();                      // silent stop, no event — the hard case
  await new Promise(r=>setTimeout(r,2600));
  ok('poll releases lock after a silent stop', p.awakeProc===null, `reasons=${[...p.awakeReasons]}`);
}

console.log('\n--- ended event path ---');
{
  const t=track(), s=stream([t]);
  setNavigator({ getUserMedia: async()=>s });
  const p=mkPlugin(); p.hookRecording();
  await navigator.mediaDevices.getUserMedia({audio:true});
  ok('lock held', p.awakeProc!==null);
  t.endWithEvent();
  ok('released on ended event', p.awakeProc===null);
}

console.log('\n--- does not fire on non-audio or when disabled ---');
{
  const s=stream([]);
  setNavigator({ getUserMedia: async()=>s });
  const p=mkPlugin(); p.hookRecording();
  await navigator.mediaDevices.getUserMedia({video:true});
  ok('video-only request ignored', p.awakeProc===null);

  const t=track(), s2=stream([t]);
  setNavigator({ getUserMedia: async()=>s2 });
  const p2=mkPlugin(); p2.settings.keepAwakeRecording=false; p2.hookRecording();
  await navigator.mediaDevices.getUserMedia({audio:true});
  ok('respects the off switch', p2.awakeProc===null);
}

console.log('\n--- a failing hook must never break recording ---');
{
  const t=track(), s=stream([t]);
  setNavigator({ getUserMedia: async()=>s });
  const p=mkPlugin(); p.onRecordingStarted=()=>{ throw new Error('boom'); }; p.hookRecording();
  let got=null, threw=false;
  try { got=await navigator.mediaDevices.getUserMedia({audio:true}); } catch(e){ threw=true; }
  ok('caller still gets the stream', !threw && got===s);
}

console.log('\n--- unhook on unload ---');
{
  const s=stream([track()]);
  const orig=async()=>s;
  setNavigator({ getUserMedia: orig });
  const p=mkPlugin(); p.hookRecording();
  p._unhook();
  // orig is a bound copy, so assert behaviour rather than identity
  ok('clears the hooked marker', navigator.mediaDevices.__ltHooked===undefined);
  await navigator.mediaDevices.getUserMedia({audio:true});
  ok('no longer takes a wake lock after unload', p.awakeProc===null);
  ok('can be re-hooked cleanly', (()=>{p.hookRecording();return navigator.mediaDevices.__ltHooked===true;})());
}

for(const id of timers) clearInterval(id);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})();
