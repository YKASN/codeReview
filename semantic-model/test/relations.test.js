import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFileReferences } from '../src/relations.js';

const definition = (id, file_id, project_id = 'p') => ({ id, file_id, project_id, role: 'definition', symbol_id: 's' });
const reference = (id, symbol_id = 's', file_id = 'a', project_id = 'p') => ({ id, symbol_id, file_id, project_id, role: symbol_id ? 'reference' : 'unresolved' });
function rows(definitions, references) {
  return { occurrences: [...definitions, ...references], symbols: [{ id: 's', definition_ids: definitions.map(d => d.id) }, { id: 'external', definition_ids: [] }] };
}

test('file relations preserve reference evidence, definition locations and project contexts', () => {
  const { references, coverage } = deriveFileReferences(rows([definition('d1', 'b'), definition('d2', 'b')], [reference('r1'), reference('r2'), reference('r3', 's', 'a', 'other')]));
  assert.equal(references.length, 2);
  const relation = references.find(r => r.source_project_id === 'p');
  assert.equal(relation.kind, 'symbol-reference');
  assert.equal(relation.target_file_id, 'b');
  assert.equal(relation.evidence_count, 2);
  assert.deepEqual(relation.evidence[0].definition_ids, ['d1', 'd2']);
  assert.equal(relation.evidence[0].target_status, 'unique-target-file');
  assert.equal(coverage.cross_file, 3);
});

test('multiple definition files remain candidates, including ambiguity with a same-file definition', () => {
  const { references, coverage } = deriveFileReferences(rows([definition('da', 'a'), definition('db', 'b'), definition('dc', 'c')], [reference('r')]));
  assert.equal(references.length, 2);
  assert.ok(references.every(r => r.resolution_status === 'contains-candidate-targets' && r.evidence[0].target_status === 'candidate-target-file'));
  assert.equal(coverage.ambiguous_cross_file, 1);
});

test('missing symbols, external definitions and same-file references do not invent cross-file edges', () => {
  const { references, coverage } = deriveFileReferences(rows([definition('d', 'a')], [reference('null', null), reference('external', 'external'), reference('same')]));
  assert.deepEqual(references, []);
  assert.equal(coverage.missing_symbol, 1);
  assert.equal(coverage.no_indexed_definition, 1);
  assert.equal(coverage.same_file_only, 1);
});
