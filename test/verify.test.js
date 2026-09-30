const fs=require('fs'),path=require('path'),os=require('os');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

// verifyWhisper is module-level; pull it out with its helpers.
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
const start=code.indexOf('const WIN_START_FAILURES');
const end=code.indexOf('\n}\n', code.indexOf("return attempt('--help')"))+3;
const mk=(platform)=>new Function('fs','path','spawn','IS_WIN','process',
  code.slice(start,end)+'; return {verifyWhisper, missingMsvcRuntime, WIN_START_FAILURES};')
  (fs,path,require('child_process').spawn, platform==='win32', process);

(async()=>{
const M=mk('darwin');

console.log('\n--- against the real whisper-cli on this machine ---');
{
  const real='/opt/homebrew/bin/whisper-cli';
  if (!fs.existsSync(real)) console.log('  SKIP  (whisper-cli not installed)');
  else {
    const r=await M.verifyWhisper(real);
    ok('accepts a genuine whisper build', r.ok===true, JSON.stringify(r));
  }
}

console.log('\n--- rejects things that are not whisper ---');
{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'v-'));
  const silent=path.join(d,'silent.sh');
  fs.writeFileSync(silent,'#!/bin/sh\nexit 0\n'); fs.chmodSync(silent,0o755);
  let r=await M.verifyWhisper(silent);
  ok('a program that prints nothing is rejected', r.ok===false && /no output at all/.test(r.why), r.why);
  ok('and is flagged as a start failure', r.startFailure===true);

  const chatty=path.join(d,'chatty.sh');
  fs.writeFileSync(chatty,'#!/bin/sh\necho "hello from something else"\nexit 0\n'); fs.chmodSync(chatty,0o755);
  r=await M.verifyWhisper(chatty);
  ok('a program with the wrong output is rejected', r.ok===false && /hello from something else/.test(r.why), r.why);
  ok('but is not called a start failure', r.startFailure===false);

  r=await M.verifyWhisper(path.join(d,'does-not-exist'));
  ok('a missing file is reported clearly', r.ok===false && /could not be started/.test(r.why), r.why);

  // accepts -h when --help says nothing
  const honly=path.join(d,'honly.sh');
  fs.writeFileSync(honly,'#!/bin/sh\n[ "$1" = "-h" ] && echo "usage: whisper" >&2\nexit 0\n'); fs.chmodSync(honly,0o755);
  r=await M.verifyWhisper(honly);
  ok('falls back to -h when --help is silent', r.ok===true, JSON.stringify(r));

  // usage on stderr only, as the real one does
  const errOnly=path.join(d,'err.sh');
  fs.writeFileSync(errOnly,'#!/bin/sh\necho "usage: whisper -m FNAME" >&2\nexit 1\n'); fs.chmodSync(errOnly,0o755);
  r=await M.verifyWhisper(errOnly);
  ok('accepts usage on stderr with a non-zero exit', r.ok===true, JSON.stringify(r));
  fs.rmSync(d,{recursive:true});
}

console.log('\n--- Windows start-failure exit codes are named ---');
{
  ok('0xC0000135 means a missing DLL', /DLL is missing/.test(M.WIN_START_FAILURES[3221225781]));
  ok('0xC0000005 means a startup crash', /crashed on startup/.test(M.WIN_START_FAILURES[3221225477]));
  ok('0xC0000409 points at antivirus', /antivirus/.test(M.WIN_START_FAILURES[3221226505]));
}

console.log('\n--- MSVC runtime detection ---');
{
  const mac=mk('darwin');
  ok('never claims a missing runtime off Windows', mac.missingMsvcRuntime()===false);
  const win=mk('win32');
  // point SystemRoot at a folder that definitely lacks the DLLs
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'sr-')); fs.mkdirSync(path.join(d,'System32'));
  const old=process.env.SystemRoot; process.env.SystemRoot=d;
  ok('detects the runtime as missing when the DLLs are absent', win.missingMsvcRuntime()===true);
  fs.writeFileSync(path.join(d,'System32','vcruntime140.dll'),'x');
  fs.writeFileSync(path.join(d,'System32','msvcp140.dll'),'x');
  ok('detects it as present once both DLLs exist', win.missingMsvcRuntime()===false);
  process.env.SystemRoot=old; fs.rmSync(d,{recursive:true});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
