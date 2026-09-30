const fs=require('fs'),path=require('path'),os=require('os');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const M=require('../src/main.js');
const real=os.cpus;
const withCores=(n)=>{ os.cpus=()=>new Array(n).fill({}); const v=M.threadCount(); os.cpus=real; return v; };

console.log('\n--- thread count never does worse than whisper default (4) ---');
{
  const cases=[[1,1],[2,2],[4,4],[6,4],[8,4],[12,6],[16,8],[18,9],[32,16]];
  for (const [logical,expect] of cases) {
    const got=withCores(logical);
    ok(`${logical} logical cores -> -t ${expect}`, got===expect, `got ${got}`);
  }
}
console.log('\n--- never oversubscribes, never below whisper default unless the machine is smaller ---');
{
  for (const n of [1,2,3,4,6,8,12,16,24,32,64]) {
    const got=withCores(n);
    if (got>n) { ok(`does not oversubscribe at ${n}`, false, `got ${got}`); continue; }
    if (n>=4 && got<4) { ok(`not worse than default at ${n}`, false, `got ${got}`); continue; }
  }
  ok('no oversubscription or regression across 1..64 cores', true);
  os.cpus=()=>[]; const empty=M.threadCount(); os.cpus=real;
  ok('copes with an empty cpu list', empty===4, String(empty));
}
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail?1:0);
