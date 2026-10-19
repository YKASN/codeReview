import test from 'node:test';
import assert from 'node:assert/strict';
import {classifySymbolOrigins,parseSymbolIdentity} from '../src/symbols.js';
import {deriveCandidates} from '../src/rules.js';
const file={id:'f',path:'pkg/main.py',language:'python',sha256:'source'};
const declaration={id:'s',file_id:'f',source_sha256:'source',range:[0,0,5,0],position_encoding:'UTF8CodeUnitOffsetFromLineStart',name:'work',kind:'function',symbol_id:'sym',parameters:[{name:'value',kind:'positional',default:null}],decorators:[]};
const reference=(id,line)=>({id,file_id:'f',range:[line,0,line,4],role:'reference',symbol_id:'sym',position_encoding:'UTF8CodeUnitOffsetFromLineStart'});
function rows(extra={}){return {files:[file],structures:[declaration],occurrences:[],calls:[],imports:[],diagnostics:[],...extra};}

test('SCIP package headers preserve escaped spaces and never guess local names',()=>{
  assert.equal(parseSymbolIdentity('scip-python python my  library 1 mod/work().').package_name,'my library');
  assert.equal(parseSymbolIdentity('local 2'),null);
  assert.equal(parseSymbolIdentity('broken'),null);
});
test('known stdlib and package symbols remain identified without source definitions',()=>{
  const symbol=(id,raw,definitions=[])=>({id,producer_symbol:raw,definition_ids:definitions,resolution_status:'unresolved'});
  const symbols=[symbol('own','scip-python python app 1 main/work().',['def']),symbol('std','scip-python python python-stdlib 3.11 pathlib/Path#'),symbol('pkg','scip-python python requests 2.32 api/get().'),symbol('missing','scip-python python app 1 missing/work().')];
  classifySymbolOrigins(symbols);
  assert.equal(symbols[1].origin_classification,'standard-library');assert.equal(symbols[1].resolution_status,'external');
  assert.equal(symbols[2].origin_classification,'dependency');
  assert.equal(symbols[3].origin_classification,'snapshot-package-unindexed');assert.equal(symbols[3].resolution_status,'unresolved');
});
test('absence of references is a candidate; callback references count as use even without a call',()=>{
  const missing=deriveCandidates(rows());assert.equal(missing.candidates[0].status,'candidate');assert.equal(missing.candidates[0].reason,'no-indexed-reference');
  assert.equal(deriveCandidates(rows({occurrences:[reference('callback',8)]})).candidates.length,0);
  assert.equal(deriveCandidates(rows({structures:[{...declaration,symbol_id:null}]})).candidates.length,0);
});
test('self-only references retain evidence and decorated or exported entry points retain uncertainty hints',()=>{
  const result=deriveCandidates(rows({structures:[{...declaration,decorators:['route("/")'],exported:true}],occurrences:[reference('self',2)]}));
  assert.equal(result.candidates[0].reason,'only-references-within-declaration');assert.deepEqual(result.candidates[0].evidence.reference_occurrence_ids,['self']);
  assert.ok(result.candidates[0].limitations.includes('decorated-declaration'));assert.ok(result.candidates[0].limitations.includes('exported-api'));
});
test('simple arity rules skip argument expansion, keyword calls and decorators',()=>{
  const call={id:'call',file_id:'f',range:[8,0,8,6],resolution_status:'resolved-static',target_symbol_id:'sym',binding_occurrence_ids:['ref'],argument_shape:{positional:0,keywords:[],expansion:false}};
  const result=deriveCandidates(rows({occurrences:[reference('ref',8)],calls:[call]}));assert.equal(result.candidates[0].rule_id,'python-simple-call-arity');
  for(const argument_shape of [{positional:0,keywords:[],expansion:true},{positional:0,keywords:['value'],expansion:false},{positional:1,keywords:[],expansion:false}])assert.equal(deriveCandidates(rows({occurrences:[reference('ref',8)],calls:[{...call,argument_shape}]})).candidates.length,0);
  assert.equal(deriveCandidates(rows({structures:[{...declaration,decorators:['wrapped']}],occurrences:[reference('ref',8)],calls:[call]})).candidates.length,0);
});
test('missing relative source modules are candidates while namespace and installed absolute imports are not',()=>{
  const item={id:'i',file_id:'f',range:[1,0,1,20],module:'missing',relative_level:1};
  const result=deriveCandidates(rows({structures:[],imports:[item]}));assert.equal(result.candidates[0].rule_id,'python-relative-import-no-source');
  assert.equal(deriveCandidates(rows({structures:[],imports:[{...item,relative_level:0}]})).candidates.length,0);
  assert.equal(deriveCandidates(rows({files:[file,{id:'other',path:'pkg/missing/child.py',language:'python'}],structures:[],imports:[item]})).candidates.length,0);
});
