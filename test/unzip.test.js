const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

// pull the extractor out of main.js (module-level, not exported)
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8');
const i=code.indexOf('function unzip(');
const j=code.indexOf("\n}\n", code.indexOf('if (!written)'))+3;
const unzip=new Function('fs','path','zlib',code.slice(i,j)+'; return unzip;')(fs,path,require('zlib'));

const ZIP=process.env.WINZIP;
const h=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const list=(d)=>{const out=[];(function w(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);e.isDirectory()?w(f):out.push(path.relative(d,f).split(path.sep).join('/'));}})(d);return out.sort();};

console.log('\n--- against the real whisper.cpp Windows archive ---');
if (!ZIP || !fs.existsSync(ZIP)) {
  console.log('  SKIP  (set WINZIP to the downloaded zip)');
} else {
  const a=fs.mkdtempSync(path.join(os.tmpdir(),'js-')), b=fs.mkdtempSync(path.join(os.tmpdir(),'tar-'));
  const tar=cp.spawnSync('tar',['-xf',ZIP,'-C',b]);
  unzip(ZIP,a);
  const la=list(a), lb=list(b);
  ok('extracts every file tar does', la.length>0 && JSON.stringify(la)===JSON.stringify(lb), `js=${la.length} tar=${lb.length}`);
  ok('whisper-cli.exe is byte-identical', h(path.join(a,'Release/whisper-cli.exe'))===h(path.join(b,'Release/whisper-cli.exe')));
  ok('ships the CPU dispatch DLLs', la.filter(f=>/ggml-cpu-.*\.dll$/i.test(f)).length>=5, String(la.filter(f=>/\.dll$/i.test(f)).length));
  ok('preserves the Release/ subfolder', la.every(f=>f.startsWith('Release/')));
  fs.rmSync(a,{recursive:true}); fs.rmSync(b,{recursive:true});
}

console.log('\n--- rejects things that are not a zip ---');
{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'z-'));
  const html=path.join(d,'x.zip'); fs.writeFileSync(html,'<!DOCTYPE html><html>error page</html>');
  let msg=''; try{ unzip(html,d); }catch(e){ msg=e.message; }
  ok('an HTML error page is caught, not parsed', msg.includes('not a zip archive'), msg);

  const trunc=path.join(d,'t.zip'); fs.writeFileSync(trunc,Buffer.from([0x50,0x4b,0x03,0x04,0,0,0,0]));
  msg=''; try{ unzip(trunc,d); }catch(e){ msg=e.message; }
  ok('a truncated zip is caught', msg.length>0, msg);
  fs.rmSync(d,{recursive:true});
}

console.log('\n--- round trip on a zip we build ---');
{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'r-'));
  const srcDir=path.join(d,'src'); fs.mkdirSync(path.join(srcDir,'sub'),{recursive:true});
  const big='x'.repeat(50000);           // compressible -> deflate
  fs.writeFileSync(path.join(srcDir,'a.txt'),big);
  fs.writeFileSync(path.join(srcDir,'sub','b.bin'),crypto.randomBytes(3000)); // incompressible -> may be stored
  const zip=path.join(d,'out.zip');
  cp.spawnSync('zip',['-r',zip,'.'],{cwd:srcDir,stdio:'ignore'});
  if (!fs.existsSync(zip)) { console.log('  SKIP  (no zip command)'); }
  else {
    const outDir=path.join(d,'out'); unzip(zip,outDir);
    ok('deflated file restored exactly', fs.readFileSync(path.join(outDir,'a.txt'),'utf8')===big);
    ok('nested binary restored exactly', h(path.join(outDir,'sub','b.bin'))===h(path.join(srcDir,'sub','b.bin')));
  }
  fs.rmSync(d,{recursive:true});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
