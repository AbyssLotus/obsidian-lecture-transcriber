const fs=require('fs'),path=require('path');
let pass=0,fail=0; const ok=(n,c,x='')=>{c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${x}`));};
const M=require('../src/main.js'); const {TFile}=require('obsidian');
const code=fs.readFileSync(path.join(__dirname,'..','src','main.js'),'utf8').replace(/\r\n/g,'\n');
const i=code.indexOf('function noteDate(');
const j=code.indexOf('\n}\n', code.indexOf('return out;', code.indexOf('function transcriptsIn')))+3;
const H=new Function(code.slice(i,j)+'; return {noteDate, ymd, transcriptsIn};')();

const f=(name,ctime)=>{const t=new TFile(name+'.md'); t.stat={ctime,mtime:ctime}; return t;};

console.log('\n--- dates come from the filename, not the file time ---');
{
  // a real case from the vault: the name says the 28th, the file time says the 29th
  const lie=new Date(2026,8,29).getTime();
  ok('M.D.YY parsed', H.ymd(H.noteDate(f('9.28.26 - Week 2 Class 1',lie)))==='2026-09-28',
     H.ymd(H.noteDate(f('9.28.26 - Week 2 Class 1',lie))));
  ok('M.D.YYYY parsed', H.ymd(H.noteDate(f('9.25.2026 Week 1 - Class 3',lie)))==='2026-09-25');
  ok('ISO parsed', H.ymd(H.noteDate(f('2026-09-22 Lecture',lie)))==='2026-09-22');
  // A filename cannot contain '/', so dashes are the realistic alternative.
  ok('dashes parsed', H.ymd(H.noteDate(f('9-30-26 Class',lie)))==='2026-09-30',
     H.ymd(H.noteDate(f('9-30-26 Class',lie))));
  ok('a date mid-name is found', H.ymd(H.noteDate(f('Week 2 Class 3 10.1.26',lie)))==='2026-10-01',
     H.ymd(H.noteDate(f('Week 2 Class 3 10.1.26',lie))));
  ok('falls back to the file time when the name has no date',
     H.ymd(H.noteDate(f('Chemistry notes',lie)))==='2026-09-29');
  ok('a nonsense date does not become a real one',
     H.ymd(H.noteDate(f('Week 99.99.99 thing',lie)))==='2026-09-29',
     H.ymd(H.noteDate(f('Week 99.99.99 thing',lie))));
}

console.log('\n--- only transcript text is collected ---');
{
  const note=[
    'My own typed notes about piecewise functions.',
    '',
    '<!-- transcribed: rec1.m4a -->',
    '## Piecewise Functions',
    '',
    '*Transcribed 2026-09-25 with large-v3.*',
    '',
    '> [!warning] This transcript may be incomplete',
    '> Whisper repeated itself heavily here.',
    '',
    '### Summary',
    '',
    'A summary that should not be treated as transcript.',
    '',
    '### Key points',
    '',
    '- a key point',
    '',
    '### Transcript',
    '',
    ('the actual spoken words go here and there are plenty of them '.repeat(4)),
    '',
    '<!-- transcribed: rec2.m4a -->',
    '## Second recording',
    '',
    '### Transcript',
    '',
    ('second recording spoken words repeated enough to count as real content '.repeat(4)),
  ].join('\n');

  const parts=H.transcriptsIn(note);
  ok('finds both transcripts', parts.length===2, String(parts.length));
  ok('keeps the spoken words', parts[0].text.includes('the actual spoken words go here'));
  ok('excludes the summary', !parts[0].text.includes('should not be treated as transcript'));
  ok('excludes the key points', !parts[0].text.includes('a key point'));
  ok('excludes the warning callout', !parts[0].text.includes('repeated itself heavily'));
  ok('excludes the user\'s own notes', !parts[0].text.includes('My own typed notes'));
  ok('records which recording each came from', parts[0].audio==='rec1.m4a' && parts[1].audio==='rec2.m4a');
  ok('ignores a transcript too short to be real', H.transcriptsIn(
     '<!-- transcribed: x.m4a -->\n### Transcript\n\nhello there\n').length===0);
}

console.log('\n--- parsing the model output ---');
{
  const p=Object.create(M.prototype);
  p.settings={mathNotation:true};
  p.parseStudyNotes=M.prototype.parseStudyNotes; p.normalizeMath=M.prototype.normalizeMath;
  const raw=[
    '<think>planning</think>',
    'TITLE: Piecewise Functions and Composition',
    'OVERVIEW:',
    'These lectures covered piecewise functions.',
    'They also covered composing two functions.',
    'CONCEPTS:',
    '- Piecewise function — a function defined by several expressions, each over its own interval',
    '- Vertex of a parabola — found at \\[x = -b/2a\\]',
    'VOCABULARY:',
    '- Domain — the set of inputs a function accepts',
    '- Composition — applying one function to the result of another',
  ].join('\n');
  const r=p.parseStudyNotes(raw);
  ok('title', r.title==='Piecewise Functions and Composition', r.title);
  ok('overview joins its lines', r.overview.includes('piecewise functions') && r.overview.includes('composing'), r.overview);
  ok('concepts split into term and explanation', r.concepts.length===2 && r.concepts[0].term==='Piecewise function', JSON.stringify(r.concepts[0]));
  ok('vocabulary split into term and meaning', r.vocab.length===2 && r.vocab[0].term==='Domain', JSON.stringify(r.vocab[0]));
  ok('display maths converted to inline for a bullet', !r.concepts[1].meaning.includes('\\['), r.concepts[1].meaning);
  ok('and is wrapped in dollars', /\$x = -b\/2a\$/.test(r.concepts[1].meaning), r.concepts[1].meaning);
  ok('garbage degrades without throwing', (()=>{const g=p.parseStudyNotes('nothing structured');return g.title===''&&g.concepts.length===0;})());
}

console.log('\n--- the written note ---');
(async()=>{
  const created=new Map();
  const p=Object.create(M.prototype);
  p.settings={mathNotation:false,studyNotesFolder:'',studyUseOwnKnowledge:true};
  p.writeStudyNotes=M.prototype.writeStudyNotes;
  const n1={file:new TFile('Math/9.28.26 Class 1.md'),date:new Date(2026,8,28)};
  const n2={file:new TFile('Math/9.30.26 Class 3.md'),date:new Date(2026,8,30)};
  p.app={vault:{
    getAbstractFileByPath:(x)=>created.has(x)?{path:x}:null,
    create:async(x,c)=>{created.set(x,c);return {path:x};},
  }};
  global.window={};
  const digest={title:'Piecewise and Composition',overview:'An overview sentence.',
    concepts:[{term:'Piecewise',meaning:'several expressions'}],
    vocab:[{term:'Domain',meaning:'the inputs'},{term:'Pipe | test',meaning:'has a pipe'}]};
  const target=await p.writeStudyNotes([n1,n2],digest,'Math 2026-09-28 to 2026-09-30');
  const out=created.get(target);
  ok('lands beside the lectures', target==='Math/Study notes — Math 2026-09-28 to 2026-09-30.md', target);
  ok('does not modify the lecture notes', created.size===1);
  ok('has an overview section', out.includes('## Overview')&&out.includes('An overview sentence.'));
  ok('has key concepts in bold', out.includes('- **Piecewise** — several expressions'));
  ok('has a vocabulary table', out.includes('| Term | Meaning |')&&out.includes('| Domain | the inputs |'));
  ok('escapes a pipe inside a table cell', out.includes('Pipe \\| test'), out.split('\n').find(l=>l.includes('Pipe')));
  ok('links back to the source lectures', out.includes('[[9.28.26 Class 1]]')&&out.includes('[[9.30.26 Class 3]]'));
  ok('says how many lectures it used', out.includes('from 2 lectures'));

  const again=await p.writeStudyNotes([n1,n2],digest,'Math 2026-09-28 to 2026-09-30');
  ok('never overwrites an existing note', again.endsWith('(2).md'), again);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERR',e);process.exit(2);});
