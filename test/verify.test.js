const fs=require('fs'),path=require('path'),os=require('os'),{EventEmitter}=require('events');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

// verifyWhisper is module-level. Extract it with its helpers, injecting spawn so
// the behaviour can be tested identically on every OS — fake executables would
// mean shell scripts on POSIX and something else on Windows.
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
const start=code.indexOf('const WIN_START_FAILURES');
const end=code.indexOf('\n}\n', code.indexOf("return attempt('--help')"))+3;
const build=(opts)=>new Function('fs','path','spawn','IS_WIN','process',
  code.slice(start,end)+'; return {verifyWhisper, missingMsvcRuntime, WIN_START_FAILURES};')
  (fs,path,opts.spawn,opts.isWin||false,process);

// A stand-in child process. `script` decides what each flag produces.
const fakeSpawn=(script)=>(bin,args)=>{
  const child=new EventEmitter();
  child.stdout=new EventEmitter(); child.stderr=new EventEmitter();
  child.kill=()=>{};
  const r=script(args[0]);
  if (r.throws) throw new Error(r.throws);
  setImmediate(()=>{
    if (r.spawnError) { child.emit('error', new Error(r.spawnError)); return; }
    if (r.stdout) child.stdout.emit('data', r.stdout);
    if (r.stderr) child.stderr.emit('data', r.stderr);
    if (!r.hang) child.emit('close', r.code===undefined?0:r.code);
  });
  return child;
};
const USAGE='usage: whisper-cli [options] file.wav\n  -m FNAME, --model FNAME\n';

(async()=>{
console.log('\n--- what counts as a working Whisper ---');
{
  let v=build({spawn:fakeSpawn(()=>({stderr:USAGE,code:0}))});
  ok('accepts usage printed on stderr', (await v.verifyWhisper('x')).ok===true);

  v=build({spawn:fakeSpawn(()=>({stderr:USAGE,code:1}))});
  ok('accepts usage even with a non-zero exit', (await v.verifyWhisper('x')).ok===true);

  v=build({spawn:fakeSpawn(()=>({stdout:USAGE,code:0}))});
  ok('accepts usage on stdout too', (await v.verifyWhisper('x')).ok===true);

  v=build({spawn:fakeSpawn((f)=>f==='-h'?{stderr:USAGE,code:0}:{code:0})});
  const r=await v.verifyWhisper('x');
  ok('falls back to -h when --help is silent', r.ok===true, JSON.stringify(r));
}

console.log('\n--- what is rejected, and how it is described ---');
{
  let v=build({spawn:fakeSpawn(()=>({code:0}))});
  let r=await v.verifyWhisper('x');
  ok('silence is rejected', r.ok===false && /no output at all/.test(r.why), r.why);
  ok('silence is flagged as a start failure', r.startFailure===true);

  v=build({spawn:fakeSpawn(()=>({stdout:'hello from something else',code:0}))});
  r=await v.verifyWhisper('x');
  ok('wrong output is rejected and quoted', /hello from something else/.test(r.why), r.why);
  ok('wrong output is not a start failure', r.startFailure===false);

  v=build({spawn:fakeSpawn(()=>({spawnError:'ENOENT'}))});
  r=await v.verifyWhisper('x');
  ok('a missing file is explained', /could not be started/.test(r.why), r.why);

  v=build({spawn:fakeSpawn(()=>({throws:'EACCES'}))});
  r=await v.verifyWhisper('x');
  ok('a spawn that throws is caught', /could not be started/.test(r.why), r.why);
}

console.log('\n--- Windows start-failure exit codes are translated ---');
{
  for (const [code,expect] of [[3221225781,/DLL is missing/],[3221225595,/wrong version/],
                               [3221225477,/crashed on startup/],[3221226505,/antivirus/]]) {
    const v=build({spawn:fakeSpawn(()=>({code})),isWin:true});
    const r=await v.verifyWhisper('x');
    ok(`exit ${code} is named`, r.ok===false && expect.test(r.why) && r.startFailure===true, r.why);
  }
  const v=build({spawn:fakeSpawn(()=>({code:2})),isWin:true});
  const r=await v.verifyWhisper('x');
  ok('an ordinary non-zero exit is not mislabelled', !/DLL|antivirus/.test(r.why), r.why);
}

console.log('\n--- MSVC runtime detection ---');
{
  ok('never claims a missing runtime off Windows', build({spawn:fakeSpawn(()=>({}))}).missingMsvcRuntime()===false);

  const win=build({spawn:fakeSpawn(()=>({})),isWin:true});
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'sr-')); fs.mkdirSync(path.join(d,'System32'));
  const old=process.env.SystemRoot; process.env.SystemRoot=d;
  ok('missing when neither DLL is present', win.missingMsvcRuntime()===true);
  fs.writeFileSync(path.join(d,'System32','vcruntime140.dll'),'x');
  ok('still missing with only one of the two', win.missingMsvcRuntime()===true);
  fs.writeFileSync(path.join(d,'System32','msvcp140.dll'),'x');
  ok('present once both exist', win.missingMsvcRuntime()===false);
  process.env.SystemRoot=old; fs.rmSync(d,{recursive:true});
}

console.log('\n--- against the real binary on this machine, if there is one ---');
{
  const real=['/opt/homebrew/bin/whisper-cli','/usr/local/bin/whisper-cli'].find(p=>fs.existsSync(p));
  if (!real) console.log('  SKIP  (no whisper-cli installed here)');
  else {
    const v=build({spawn:require('child_process').spawn});
    const r=await v.verifyWhisper(real);
    ok('accepts the genuine installed build', r.ok===true, JSON.stringify(r));
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
