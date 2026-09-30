const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};

// pull the extractor out of main.js (module-level, not exported)
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
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

console.log('\n--- round trip on a zip built here, so this runs anywhere ---');
{
  const zlib=require('zlib');
  // Minimal zip writer: enough to exercise both stored and deflated entries
  // without depending on a `zip` command existing on the runner.
  const makeZip=(entries)=>{
    const locals=[], central=[]; let off=0;
    for (const e of entries) {
      const name=Buffer.from(e.name,'utf8');
      const deflated=zlib.deflateRawSync(e.data);
      const useDeflate=deflated.length < e.data.length;
      const body=useDeflate?deflated:e.data;
      const method=useDeflate?8:0;
      const crc=zlib.crc32?zlib.crc32(e.data):0;
      const lh=Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
      lh.writeUInt16LE(method,8); lh.writeUInt32LE(crc,14);
      lh.writeUInt32LE(body.length,18); lh.writeUInt32LE(e.data.length,22);
      lh.writeUInt16LE(name.length,26); lh.writeUInt16LE(0,28);
      locals.push(lh,name,body);
      const ch=Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6);
      ch.writeUInt16LE(method,10); ch.writeUInt32LE(crc,16);
      ch.writeUInt32LE(body.length,20); ch.writeUInt32LE(e.data.length,24);
      ch.writeUInt16LE(name.length,28); ch.writeUInt32LE(off,42);
      central.push(ch,name);
      off += lh.length+name.length+body.length;
    }
    const cd=Buffer.concat(central);
    const eocd=Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,0);
    eocd.writeUInt16LE(entries.length,8); eocd.writeUInt16LE(entries.length,10);
    eocd.writeUInt32LE(cd.length,12); eocd.writeUInt32LE(off,16);
    return Buffer.concat([...locals,cd,eocd]);
  };

  const d=fs.mkdtempSync(path.join(os.tmpdir(),'rt-'));
  const text=Buffer.from('x'.repeat(50000));                 // compresses -> deflate
  const bin=crypto.randomBytes(3000);                        // does not -> stored
  const zip=path.join(d,'built.zip');
  fs.writeFileSync(zip, makeZip([
    {name:'a.txt',data:text},
    {name:'nested/deep/b.bin',data:bin},
  ]));

  const out=path.join(d,'out');
  unzip(zip,out);
  ok('deflated entry restored byte-for-byte', fs.readFileSync(path.join(out,'a.txt')).equals(text));
  ok('stored entry restored byte-for-byte', fs.readFileSync(path.join(out,'nested','deep','b.bin')).equals(bin));
  ok('created nested directories', fs.existsSync(path.join(out,'nested','deep')));

  // path traversal must not escape the destination
  const evil=path.join(d,'evil.zip');
  fs.writeFileSync(evil, makeZip([{name:'../escaped.txt',data:Buffer.from('nope')}]));
  const out2=path.join(d,'out2');
  unzip(evil,out2);
  ok('refuses to write outside the destination', !fs.existsSync(path.join(d,'escaped.txt')));
  fs.rmSync(d,{recursive:true});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
