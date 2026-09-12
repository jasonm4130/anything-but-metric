import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { unit } from 'mathjs';
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const dir = await mkdtemp(resolve(tmpdir(), 'abm-corpus-check-'));
try {
  await build({ stdin:{contents:'export * from "./src/lib/comparison-flow"; export * from "./src/lib/measurement"; export * from "./src/lib/convert";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:resolve(dir,'engine.mjs') });
  const {comparisonPool,comparisonMenu,comparisonResult,interpretMeasurement,validateMeasurement}=await import(pathToFileURL(resolve(dir,'engine.mjs')));
  const suite=await read('evals/production-acceptance-29.json'); const cases=[];
  for(const c of suite.cases) {
    let parserCalls=0;
    const parsed=await interpretMeasurement(c.input,async()=>{parserCalls++;return c.parserFixture??{recognized:false,quantity:0,sourceUnit:'m'};});
    let actual='unrecognized',pool=[]; let validated;
    if(parsed.recognized) {
      try{validated=validateMeasurement(parsed.quantity,parsed.sourceUnit);actual='coverage_gap';}catch{actual='invalid_measurement';}
      if(validated){pool=comparisonPool(validated);if(pool.length)actual='answer';}
    }
    const errors=[];
    if(c.expected.parserCalls!==parserCalls)errors.push('parser_call_count');
    if(c.expected.outcome!==actual && !(c.expected.outcome==='coverage_gap' && actual==='answer'))errors.push('outcome');
    if(validated && c.expected.dimension!==null) {
      const actualQuantity=unit(parsed.quantity,parsed.sourceUnit).toNumber(c.expected.sourceUnit);
      if(Math.abs(actualQuantity-c.expected.quantity)>Math.abs(c.expected.quantity)*1e-12)errors.push('quantity');
      if(validated.dimension!==c.expected.dimension)errors.push('dimension');
    }
    const heads=[];let history=[];
    if(actual==='answer')for(let i=0;i<12;i++){
      const menu=comparisonMenu(parsed,history,i);assert(menu.length>0&&menu.length<=6);assert.equal(new Set(menu.map(p=>p.id)).size,menu.length);
      const result=comparisonResult(menu[0],parsed,history);history=result.recentFamilies;heads.push(result.headline);
      assert(result.sources.every(s=>new URL(s.url).protocol==='https:'));assert(result.basis&&result.headline);
    }
    cases.push({id:c.id,input:c.input,expected:c.expected.outcome,actual,parserCalls,eligibleComparisons:pool.length,uniqueFirstSelections:new Set(heads).size,errors,samples:heads.slice(0,3)});
  }
  const timings=[];
  for(let round=0;round<15;round++)for(const measurement of [{quantity:144,sourceUnit:'J'},{quantity:2,sourceUnit:'PB'},{quantity:65,sourceUnit:'kg'},{quantity:3e12,sourceUnit:'J'}]){
    const before=process.cpuUsage();comparisonMenu(measurement,[],round);const t=process.cpuUsage(before);timings.push((t.user+t.system)/1000);
  }
  timings.sort((a,b)=>a-b);
  const corpusFiles=['src/data/references.json','src/data/reference-additions.json','src/data/corpus-additions.json'];
  const refs=(await Promise.all(corpusFiles.map(read))).flat();assert.equal(new Set(refs.map(r=>r.id)).size,refs.length);
  const anchors=(await read('src/data/scale-anchors.json')).anchors.filter(r=>r.kind!=='volume-anchor');
  const formats=(await read('src/data/data-references.json')).references;
  const ranges=(await read('src/data/animal-ranges.json')).references;
  const inventory={pointReferences:refs.length,compositionAnchors:anchors.length,dataFormats:formats.length,animalRanges:ranges.length,total:refs.length+anchors.length+formats.length+ranges.length};
  const dependencyFiles=[...corpusFiles,'src/data/scale-anchors.json','src/data/data-references.json','src/data/animal-ranges.json',...['comparison-flow','scene-packets','scene-display','range-scenes','motion-anchors','printed-data','convert','measurement','grounded-flow'].map(name=>`src/lib/${name}.ts`),'evals/production-acceptance-29.json','scripts/check-comparison-corpus.mjs'];
  const explored=new Map();
  for(const [sourceUnit,values] of Object.entries({m:[1e-6,.1,1,100,1e4,1e7,1e11],kg:[.001,.1,1,100,1e4,1e8,1e24],J:[.01,1,144,1e4,1e8,1e12,1e16],L:[.001,.1,1,100,1e6],PB:[.000001,.001,.1,1,5],s:[1,60,3600,1e6,1e9],W:[1,100,1e4,1e8],Pa:[1,1e3,1e5],N:[1,100,1e6],Hz:[1,100,1e6],'m^2':[.01,1,100,1e6],deg:[30,180]}))for(const quantity of values)for(const p of comparisonPool({quantity,sourceUnit}))explored.set(p.id,p);
  const result={recordedAt:new Date().toISOString(),references:refs.length,inventory,dimensions:[...new Set(refs.map(r=>r.dimension))].sort(),reachableDistinctComparisons:explored.size,mechanisms:[...new Set([...explored.values()].map(p=>p.mechanism))].sort(),cases,passed:cases.filter(c=>!c.errors.length).length,total:cases.length,localNodeCpuMs:{median:timings[Math.floor(timings.length/2)],p95:timings[Math.ceil(timings.length*.95)-1],max:timings.at(-1),samples:timings.length,note:'Warm Node process CPU measurements, not a Cloudflare production CPU guarantee.'},sourceHashes:Object.fromEntries(await Promise.all(dependencyFiles.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')]))) };
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result,null,2));
  if(result.passed!==result.total)process.exitCode=1;
}finally{await rm(dir,{recursive:true,force:true});}
