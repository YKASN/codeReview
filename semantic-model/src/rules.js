import path from 'node:path';
import { hash } from './inventory.js';
export const RULES_VERSION = 'code-ir-rules/1';
export const RULES = [
  { id:'function-no-external-reference', version:1, meaning:'No indexed reference outside the declaration range; not proof of dead code' },
  { id:'python-simple-call-arity', version:1, meaning:'Direct Python function call positional count differs from a simple signature' },
  { id:'python-relative-import-no-source', version:1, meaning:'Explicit relative module has no inventoried Python source target' },
  { id:'producer-diagnostic', version:1, meaning:'Indexer supplied an error or warning' },
];
export function deriveCandidates(rows) {
  const candidates = [], files = new Map(rows.files.map(f => [f.id,f]));
  const references = new Map(), declarations = new Map();
  for(const o of rows.occurrences) if(o.role!=='definition' && o.symbol_id){if(!references.has(o.symbol_id)) references.set(o.symbol_id,[]);references.get(o.symbol_id).push(o);}
  for(const s of rows.structures) if(s.symbol_id){if(!declarations.has(s.symbol_id)) declarations.set(s.symbol_id,[]);declarations.get(s.symbol_id).push(s);}
  const supported = new Set(['python','typescript','javascript','vue']);
  const add=(rule,record,reason,evidence,limitations,subject={})=>{
    const file=files.get(record.file_id);
    candidates.push({id:'candidate:'+hash(JSON.stringify([RULES_VERSION,rule,record.id])),rule_id:rule,rule_version:1,status:'candidate',
      file_id:file.id,source_sha256:file.sha256,range:record.range,position_encoding:record.position_encoding||'UnspecifiedPositionEncoding',
      reason,evidence,limitations,...subject});
  };
  let eligible=0,unbound=0,observed=0;
  for(const s of rows.structures){
    const file=files.get(s.file_id);
    if(!supported.has(file.language)||!['function','method'].includes(s.kind)||!s.name) continue;
    if(!s.symbol_id){unbound++;continue;} eligible++;
    const refs=references.get(s.symbol_id)||[];
    const inside=o=>o.file_id===s.file_id && (o.range[0]>s.range[0] && o.range[2]<s.range[2]
      || (o.position_encoding===s.position_encoding||o.range_encoding_evidence==='ascii-prefix') && (o.range[0]>s.range[0] || o.range[1]>=s.range[1]) && (o.range[2]<s.range[2] || o.range[3]<=s.range[3]) && o.range[0]>=s.range[0] && o.range[2]<=s.range[2]);
    if(refs.some(o=>!inside(o))){observed++;continue;}
    const hints=['snapshot-only','dynamic-registration-or-reflection-not-excluded'];
    if(s.decorators?.length) hints.push('decorated-declaration');
    if(s.exported) hints.push('exported-api');
    if(s.kind==='method') hints.push('method-dispatch-or-framework-hook');
    if(/^__.*__$/.test(s.name)) hints.push('python-protocol-method');
    if(/^test_|^setup_|^teardown_/.test(s.name)||/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./.test(file.path)) hints.push('test-or-lifecycle-entry');
    if(rows.files.some(f=>f.language==='vue') && file.language!=='python') hints.push('vue-template-symbol-bindings-incomplete');
    add('function-no-external-reference',s,refs.length?'only-references-within-declaration':'no-indexed-reference',
      {structure_ids:[s.id],symbol_ids:[s.symbol_id],reference_occurrence_ids:refs.map(o=>o.id)},hints,{structure_id:s.id});
  }
  for(const call of rows.calls){
    if(files.get(call.file_id).language!=='python'||call.resolution_status!=='resolved-static'||!call.argument_shape||call.argument_shape.expansion||call.argument_shape.keywords.length) continue;
    const targets=(declarations.get(call.target_symbol_id)||[]).filter(s=>s.kind==='function'&&s.name&&!s.decorators?.length);
    if(targets.length!==1) continue;
    const target=targets[0],params=target.parameters||[];
    if(params.some(p=>!['positional','positional-only'].includes(p.kind))) continue;
    const minimum=params.filter(p=>p.default===null).length,maximum=params.length,actual=call.argument_shape.positional;
    if(actual>=minimum&&actual<=maximum) continue;
    add('python-simple-call-arity',call,'positional-count-outside-signature',
      {call_ids:[call.id],structure_ids:[target.id],symbol_ids:[call.target_symbol_id],binding_occurrence_ids:call.binding_occurrence_ids,actual,minimum,maximum},
      ['snapshot-only','runtime-rebinding-not-excluded'],{call_id:call.id});
  }
  const paths=new Set(rows.files.map(f=>f.path));
  for(const item of rows.imports){
    const file=files.get(item.file_id);
    if(file.language!=='python'||!(item.relative_level>0)||!item.module) continue;
    let base=path.posix.dirname(file.path);
    for(let level=1;level<item.relative_level;level++)base=path.posix.dirname(base);
    const prefix=path.posix.join(base,item.module.replaceAll('.','/'));
    const possible=[prefix+'.py',prefix+'.pyi',prefix+'/__init__.py',prefix+'/__init__.pyi'];
    if(possible.some(p=>paths.has(p))||[...paths].some(p=>p.startsWith(prefix+'/'))) continue;
    add('python-relative-import-no-source',item,'no-inventoried-source-target',
      {import_ids:[item.id],module:item.module,relative_level:item.relative_level,checked_source_paths:possible},
      ['snapshot-inventory-only','extension-modules-import-hooks-and-excluded-files-not-excluded'],{import_id:item.id});
  }
  for(const diagnostic of rows.diagnostics){
    if(!['Error','Warning'].includes(diagnostic.severity)||!supported.has(files.get(diagnostic.file_id).language))continue;
    add('producer-diagnostic',diagnostic,'producer-reported-diagnostic',{diagnostic_ids:[diagnostic.id],code:diagnostic.code,message:diagnostic.message,severity:diagnostic.severity},['producer-diagnostic-is-not-confirmed-defect']);
  }
  candidates.sort((a,b)=>a.id.localeCompare(b.id));
  const counts=Object.fromEntries(RULES.map(rule=>[rule.id,candidates.filter(c=>c.rule_id===rule.id).length]));
  return {candidates,report:{schema_version:RULES_VERSION,supported_languages:[...supported],rules:RULES,counts,total:candidates.length,
    function_coverage:{bound_named_declarations:eligible,unbound_named_declarations:unbound,with_outside_references:observed},
    interpretation:'Candidates are deterministic observations, not confirmed defects. Missing bindings are coverage gaps, not unused-function evidence.'}};
}
