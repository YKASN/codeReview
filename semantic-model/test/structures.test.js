import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enrichStructures } from '../src/structures.js';
import { hash } from '../src/inventory.js';

function fixture(t, sources, occurrences = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-structures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = Object.entries(sources).map(([name, source], index) => {
    fs.writeFileSync(path.join(directory, name), source);
    return { id: 'file:' + index, path: name, source: name, sha256: hash(Buffer.from(source)), language: name.endsWith('.py') ? 'python' : name.endsWith('.vue') ? 'vue' : 'typescript' };
  });
  const rows = { files, projects: [], documents: [{ id: 'document:0', position_encoding: 'UnspecifiedPositionEncoding' }], occurrences };
  const symbols = new Map([['symbol:work', { id: 'symbol:work', name: null, kind: 'unknown', resolution_status: 'defined' }]]);
  const coverage = enrichStructures(directory, rows, symbols);
  return { rows, symbols, coverage };
}

test('Python syntax captures signatures, containment, imports and evidence-based static calls without executing source', t => {
  const source = 'from os import path as paths\ndef work(value: int = 1, *, scale: int = 2) -> int:\n    return value * scale\nwork()\ngetattr(object(), "work")()\nraise RuntimeError("Do not execute")\n';
  const occurrence = (id, role, range) => ({ id, role, range, file_id: 'file:0', document_id: 'document:0', symbol_id: 'symbol:work' });
  const { rows, symbols } = fixture(t, { 'main.py': source }, [occurrence('occurrence:def', 'definition', [1, 4, 1, 8]), occurrence('occurrence:ref', 'reference', [3, 0, 3, 4])]);
  const work = rows.structures.find(s => s.name === 'work');
  assert.equal(work.kind, 'function'); assert.equal(work.symbol_id, 'symbol:work');
  assert.equal(work.parameters[1].kind, 'keyword-only'); assert.equal(work.parameters[0].default, '1');
  assert.equal(work.returns, 'int'); assert.match(work.signature, /scale: int\s*=\s*2/);
  assert.equal(rows.structures.find(s => s.name === 'value').parent_id, work.id);
  assert.deepEqual(rows.imports[0].names, [{ name: 'path', alias: 'paths' }]);
  const call = rows.calls.find(c => c.callee_expression === 'work');
  assert.equal(call.target_symbol_id, 'symbol:work'); assert.deepEqual(call.binding_occurrence_ids, ['occurrence:ref']);
  assert.equal(call.resolution_status, 'resolved-static');
  assert.equal(rows.calls.find(c => c.callee_expression.startsWith('getattr(')).unresolved_reason, 'dynamic-callee-expression');
  assert.equal(symbols.get('symbol:work').kind_origin, 'syntax');
});

test('TypeScript imports preserve default, namespace, named aliases and type-only declarations', t => {
  const { rows } = fixture(t, { 'main.ts': 'import Default, { original as renamed, type Shape } from "pkg";\nimport * as ns from "other";\nexport function work(x: number = 1): number { return x; }\nwork();\n' });
  assert.deepEqual(rows.imports[0].names, [{ name: 'default', alias: 'Default' }, { name: 'original', alias: 'renamed', type_only: false }, { name: 'Shape', alias: null, type_only: true }]);
  assert.deepEqual(rows.imports[1].names, [{ name: '*', alias: 'ns' }]);
  assert.equal(rows.calls[0].resolution_status, 'unresolved');
  assert.equal(rows.calls[0].unresolved_reason, 'no-compatible-producer-binding');
  assert.equal(rows.structures.find(s => s.name === 'work').parameters[0].annotation, 'number');
});

test('invalid syntax is recorded per file while other files remain parsed', t => {
  const { rows, coverage } = fixture(t, { 'bad.py': 'def broken(:\n', 'good.py': 'value = 1\n', 'bad.ts': 'export function broken( {\n' });
  assert.equal(rows.files.find(f => f.path === 'bad.py').structure_result.status, 'failed');
  assert.equal(rows.files.find(f => f.path === 'bad.ts').structure_result.status, 'partial');
  assert.equal(rows.files.find(f => f.path === 'good.py').structure_result.status, 'parsed');
  assert.equal(rows['syntax-diagnostics'].length >= 2, true);
  assert.equal(coverage.failed_files, 2);
});

test('unspecified producer offsets after Unicode cannot establish a call binding', t => {
  const { rows } = fixture(t, { 'main.ts': 'const prefix = "🚀"; work();\n' }, [{ id: 'occurrence:uncertain', file_id: 'file:0', document_id: 'document:0', symbol_id: 'symbol:work', role: 'reference', range: [0, 21, 0, 25] }]);
  assert.equal(rows.calls[0].target_symbol_id, null);
  assert.deepEqual(rows.calls[0].binding_occurrence_ids, []);
});

test('accessor declarations are not treated as directly callable methods', t => {
  const occurrence = (id, role, range) => ({ id, role, range, file_id: 'file:0', document_id: 'document:0', symbol_id: 'symbol:work' });
  const { rows, symbols } = fixture(t, { 'main.ts': 'class A { get work() { return () => 1; } }\na.work();\n' }, [occurrence('occurrence:def', 'definition', [0, 14, 0, 18]), occurrence('occurrence:ref', 'reference', [1, 2, 1, 6])]);
  assert.equal(symbols.get('symbol:work').kind, 'GetAccessor');
  assert.equal(rows.calls[0].target_symbol_id, null);
  assert.equal(rows.calls[0].unresolved_reason, 'callable-definition-not-established');
});

test('Vue scripts preserve original ranges and template directives remain syntax facts',t=>{
  const {rows}=fixture(t,{'App.vue':'<script setup lang="ts">\nimport {run} from "./tool";\nfunction unused() {}\nrun();\n</script>\n<template><Widget @click="unused">{{ value }}</Widget></template>'});
  assert.equal(rows.files[0].structure_result.status,'parsed');
  assert.equal(rows.calls[0].range[0],3);assert.equal(rows.calls[0].resolution_status,'unresolved');
  assert.ok(rows.structures.some(s=>s.name==='unused'&&s.range[0]===2));
  assert.ok(rows['template-expressions'].some(e=>e.kind==='directive-on'&&e.expression==='unused'&&e.range[0]===5));
  assert.ok(rows['template-expressions'].some(e=>e.kind==='component'&&e.expression==='Widget'));
});

test('malformed Vue files retain diagnostics rather than pretending full coverage',t=>{
  const {rows}=fixture(t,{'Broken.vue':'<script setup>function broken(</script><template><div></template>'});
  assert.equal(rows.files[0].structure_result.status,'partial');assert.ok(rows['syntax-diagnostics'].length);
});
