import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {scan} from '../src/scan.js';
import {verifyIR} from '../src/verify-ir.js';

test('real Python scan persists rule candidates, external identities and Vue syntax without executing the application',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ir-rule-scan-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'repo');fs.mkdirSync(root);
  execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','Fixture']);
  fs.writeFileSync(path.join(root,'app.py'),'def unused():\n    return 1\ndef recursive():\n    return recursive()\ndef required(value):\n    return value\ndef callback():\n    return 1\ncallbacks = [callback]\nrequired()\nprint("Never execute target application")\nraise RuntimeError("Never execute")\n');
  fs.writeFileSync(path.join(root,'App.vue'),'<script setup lang="ts">\nfunction clicked() {}\n</script>\n<template><button @click="clicked">Run</button></template>');
  const report=await scan(root,path.join(base,'output'),{languages:['python'],timeoutMs:60000});assert.equal(report.state,'indexed',JSON.stringify(report));
  const read=name=>fs.readFileSync(path.join(report.ir.directory,name+'.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const structures=new Map(read('structures').map(s=>[s.id,s]));
  const candidates=read('candidates');
  assert.ok(candidates.some(c=>c.rule_id==='function-no-external-reference'&&structures.get(c.structure_id)?.name==='unused'));
  assert.ok(candidates.some(c=>c.reason==='only-references-within-declaration'&&structures.get(c.structure_id)?.name==='recursive'));
  assert.ok(!candidates.some(c=>structures.get(c.structure_id)?.name==='callback'));
  assert.ok(candidates.some(c=>c.rule_id==='python-simple-call-arity'));
  assert.ok(read('calls').some(c=>c.callee_name==='print'&&c.resolution_status==='identified-external'));
  assert.ok(read('template-expressions').some(e=>e.kind==='directive-on'&&e.expression==='clicked'));
  assert.ok(!candidates.some(c=>structures.get(c.structure_id)?.name==='clicked'));
  assert.equal(verifyIR(report.ir.directory).valid,true);
});
