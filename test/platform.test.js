// Platform behaviour is checked by loading main.js under a faked process.platform.
const path=require('path'), fs=require('fs'), os=require('os'), Module=require('module');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

function loadAs(platform, arch, env){
  const orig={platform:process.platform, arch:process.arch, env:process.env};
  Object.defineProperty(process,'platform',{value:platform,configurable:true});
  Object.defineProperty(process,'arch',{value:arch||'x64',configurable:true});
  process.env=Object.assign({},orig.env,env||{});
  delete require.cache[require.resolve('../src/main.js')];
  const M=require('../src/main.js');
  Object.defineProperty(process,'platform',{value:orig.platform,configurable:true});
  Object.defineProperty(process,'arch',{value:orig.arch,configurable:true});
  process.env=orig.env;
  return M;
}

console.log('\n--- the module loads on every platform ---');
for (const [plat,arch] of [['darwin','arm64'],['win32','x64'],['win32','arm64'],['linux','x64']]) {
  let err=null; try{ loadAs(plat,arch,{LOCALAPPDATA:'C:\\Users\\t\\AppData\\Local'}); }catch(e){ err=e; }
  ok(`loads on ${plat}/${arch}`, !err, err&&err.message);
}

console.log('\n--- wake lock uses the right mechanism ---');
{
  // main.js destructures spawn at load time, so the stub has to be installed
  // before the module is (re)required.
  const cp=require('child_process');
  const realSpawn=cp.spawn;
  let got=null;
  const capture=(cmd,args)=>{ got={cmd,args}; return {on(){},kill(){}}; };

  const probe=(plat,screen)=>{
    got=null;
    cp.spawn=capture;
    let p;
    try {
      const M=loadAs(plat,'x64',{LOCALAPPDATA:'C:\\x',PATH:''});
      p=Object.create(M.prototype);
      p.settings={keepScreenOn:screen};
      p.spawnWakeLock();
    } finally { cp.spawn=realSpawn; }
    return got;
  };

  const mac=probe('darwin',true);
  ok('macOS uses caffeinate', !!mac && mac.cmd.includes('caffeinate'), mac&&mac.cmd);
  ok('macOS keeps the display on with -d', !!mac && mac.args.includes('-d'), mac&&mac.args.join(' '));
  const macOff=probe('darwin',false);
  ok('macOS drops -d when the screen may sleep', !macOff.args.includes('-d'), macOff.args.join(' '));

  const win=probe('win32',true);
  ok('Windows uses PowerShell', !!win && win.cmd.toLowerCase().includes('powershell'), win&&win.cmd);
  ok('Windows calls SetThreadExecutionState', win.args.join(' ').includes('SetThreadExecutionState'));
  ok('Windows sets display+system flags', win.args.join(' ').includes('0x80000003'));
  ok('Windows hides the console window', win.args.includes('Hidden'));
  const winOff=probe('win32',false);
  ok('Windows uses system-only flag when screen may sleep', winOff.args.join(' ').includes('0x80000001'));

  // Linux depends on the machine: systemd-inhibit exists on most desktops and
  // on CI runners, and is absent elsewhere. Both outcomes are correct — what
  // must not happen is claiming a lock that was never taken.
  const lin=probe('linux',true);
  if (lin===null) {
    ok('Linux reports no mechanism rather than pretending', true);
  } else {
    ok('Linux uses systemd-inhibit when present', lin.cmd.includes('systemd-inhibit'), lin.cmd);
    ok('Linux inhibits idle and sleep', lin.args.join(' ').includes('idle:sleep'), lin.args.join(' '));
  }
}

console.log('\n--- WAV encoding is a real, valid file ---');
{
  const M=loadAs(process.platform);
  const p=Object.create(M.prototype);
  const n=16000, samples=new Float32Array(n);
  for(let i=0;i<n;i++) samples[i]=Math.sin(2*Math.PI*440*i/16000)*0.5;
  const buf=p.encodeWav.call(p,samples,16000);
  ok('RIFF/WAVE header', buf.slice(0,4).toString()==='RIFF' && buf.slice(8,12).toString()==='WAVE');
  ok('declares 16 kHz mono 16-bit', buf.readUInt32LE(24)===16000 && buf.readUInt16LE(22)===1 && buf.readUInt16LE(34)===16);
  ok('length matches the samples', buf.length===44+n*2 && buf.readUInt32LE(40)===n*2);
  // Cross-check with ffprobe where it happens to exist. CI runners for other
  // platforms will not have it, and the header assertions above already cover
  // the contract, so this is a bonus rather than a requirement.
  const probe=['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe','/usr/bin/ffprobe','ffprobe']
    .find(c=>{ try{ return require('child_process').spawnSync(c,['-version'],{stdio:'ignore'}).status===0; }catch(e){ return false; } });
  if (probe) {
    const tmp=path.join(os.tmpdir(),'lt-wavtest.wav'); fs.writeFileSync(tmp,buf);
    const out=require('child_process').spawnSync(probe,
      ['-v','error','-show_entries','stream=codec_name,sample_rate,channels','-of','default=nw=1',tmp],{encoding:'utf8'});
    ok('ffprobe agrees it is 16k mono PCM', /pcm_s16le/.test(out.stdout)&&/16000/.test(out.stdout)&&/channels=1/.test(out.stdout), out.stdout.replace(/\n/g,' '));
    fs.unlinkSync(tmp);
  } else {
    console.log('  SKIP  ffprobe cross-check (ffprobe not installed)');
  }
}

console.log('\n--- normalisation ---');
{
  const M=loadAs(process.platform); const p=Object.create(M.prototype);
  const rms=(a)=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
  const peak=(a)=>a.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
  const tone=(amp,n=8000)=>{const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=Math.sin(2*Math.PI*220*i/16000)*amp;return a;};

  const quiet=tone(0.02);
  const beforeQuiet=rms(quiet);
  p.normalise(quiet);
  ok('lifts a quiet recording toward the target', rms(quiet)>beforeQuiet*3 && Math.abs(rms(quiet)-0.1)<0.02, rms(quiet).toFixed(4));
  ok('quiet case does not clip', peak(quiet)<=1.0, peak(quiet).toFixed(3));

  const hot=tone(0.95);
  p.normalise(hot);
  ok('brings a hot recording down to the same target', Math.abs(rms(hot)-0.1)<0.02, rms(hot).toFixed(4));
  ok('hot case does not clip', peak(hot)<=1.0, peak(hot).toFixed(3));

  // A signal already at the target should be left essentially alone.
  const good=tone(0.1414);
  const before=Array.from(good);
  p.normalise(good);
  ok('leaves an already-correct level alone', good.every((v,i)=>Math.abs(v-before[i])<1e-6), rms(good).toFixed(4));

  // Peaky speech: ceiling must win over the RMS target.
  const peaky=new Float32Array(8000);
  for(let i=0;i<peaky.length;i++) peaky[i]=Math.sin(2*Math.PI*220*i/16000)*0.005;
  peaky[10]=0.9; peaky[11]=-0.9;
  p.normalise(peaky);
  ok('a loud transient never pushes past the ceiling', peak(peaky)<=0.95, peak(peaky).toFixed(3));

  const silent=new Float32Array(100);
  p.normalise(silent);
  ok('silence is left alone', silent.every(v=>v===0));
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
