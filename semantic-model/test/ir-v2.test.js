import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, inventory } from '../src/inventory.js';
import { Index } from '../src/store.js';
import { persistIR, finalizeIR, verifyIR } from '../src/ir.js';
import { rebuildSQLite } from '../src/projection.js';
import { DatabaseSync } from 'node:sqlite';

function fixture(t, { unicode = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-v2-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), output = path.join(base, 'output');
  fs.mkdirSync(root); fs.mkdirSync(output);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'Fixture']);
  fs.writeFileSync(path.join(root, 'main.py'), unicode ? '# 🚀\n' : 'def work():\n    return 1\nwork()\n');
  const producerSymbol = 'scip-python python fixture 1 main/work().';
  fs.writeFileSync(path.join(output, 'python.scip'), Index.encode(Index.fromObject({ metadata: { projectRoot: pathToFileURL(root).href },
    documents: [{ relativePath: 'main.py', positionEncoding: unicode ? 2 : 0,
      symbols: [{ symbol: producerSymbol, displayName: 'work', kind: 'Function' }],
      occurrences: unicode ? [{ symbol: producerSymbol, symbolRoles: 1, range: [0, 2, 4] }] : [
        { symbol: producerSymbol, symbolRoles: 1, range: [0, 4, 8] }, { symbol: producerSymbol, range: [2, 0, 4] },
        { symbol: 'local 0', range: [1, 4, 10] }, { range: [1, 0, 4] }],
    }] })).finish());
  const ir = persistIR(output, inventory(root), [{ indexer: 'python', status: 'indexed' }]);
  finalizeIR(ir.directory, 'indexed');
  return { root, output, ir, producerSymbol };
}
function rows(directory, dataset) { return fs.readFileSync(path.join(directory, dataset + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function mutate(directory, dataset, change) {
  const filename = dataset + '.jsonl', records = rows(directory, dataset); change(records);
  const bytes = Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''));
  fs.writeFileSync(path.join(directory, filename), bytes);
  const manifestPath = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const artifact = manifest.artifacts.find(a => a.path === filename);
  artifact.sha256 = hash(bytes); artifact.bytes = bytes.length; manifest.counts[dataset] = records.length;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}

test('SQLite is rebuilt entirely from saved IR after the original repository is removed', t => {
  const { root, output, ir } = fixture(t);
  fs.renameSync(root, root + '-removed');
  const filename = path.join(output, 'projection.sqlite');
  fs.writeFileSync(filename, 'corrupt old projection');
  const projection = rebuildSQLite(ir.directory, filename);
  const db = new DatabaseSync(filename);
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM ir_records').get().count, projection.records);
    const symbol = rows(ir.directory, 'symbols').find(s => s.name === 'work');
    assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM ir_records WHERE dataset=? AND id=?').get('symbols', symbol.id).payload), symbol);
    assert.ok(db.prepare('SELECT symbol FROM occurrences WHERE symbol=?').get(symbol.id));
    assert.equal(projection.validation.entity_links_verified, true);
  } finally { db.close(); }
  assert.throws(() => rebuildSQLite(ir.directory, path.join(ir.directory, 'bad.sqlite')), /outside canonical IR/);
});

test('IR v2 exposes normalized facts with explicit unresolved status and linked provenance', t => {
  const { ir, producerSymbol } = fixture(t);
  const symbols = rows(ir.directory, 'symbols'), occurrences = rows(ir.directory, 'occurrences');
  const symbol = symbols.find(s => s.producer_symbol === producerSymbol);
  assert.equal(symbol.name, 'work'); assert.equal(symbol.kind, 'Function');
  assert.equal(symbol.resolution_status, 'defined');
  assert.equal(symbol.definition_ids.length, 1);
  assert.equal(occurrences.find(o => o.id === symbol.definition_ids[0]).symbol_id, symbol.id);
  assert.equal(symbols.find(s => s.producer_symbol === 'local 0').name, null);
  assert.equal(symbols.find(s => s.producer_symbol === 'local 0').resolution_status, 'unresolved');
  assert.equal(occurrences.find(o => o.symbol_id === null).resolution_status, 'unresolved');
  const file = rows(ir.directory, 'files')[0], project = rows(ir.directory, 'projects')[0];
  assert.ok(file.project_ids.includes(project.id)); assert.equal(file.parse_results[0].status, 'indexed');
  assert.equal(verifyIR(ir.directory).entity_links_verified, true);
});

test('IR consistency rejects dangling symbol references even when artifact hashes are valid', t => {
  const { ir } = fixture(t);
  mutate(ir.directory, 'occurrences', values => { values[1].symbol_id = 'symbol:missing'; });
  assert.throws(() => verifyIR(ir.directory), /Dangling symbols/);
});

test('derived file evidence cannot be forged even with matching artifact checksums', t => {
  const { ir } = fixture(t);
  mutate(ir.directory, 'file-references', values => { values.push({ id: 'file-reference:forged', source_file_id: 'file:missing', target_file_id: 'file:missing', evidence: [] }); });
  assert.throws(() => verifyIR(ir.directory), /File reference projection count mismatch/);
});

test('derived overview cannot claim coverage absent from the underlying facts', t => {
  const { ir } = fixture(t);
  const filename = path.join(ir.directory, 'overview.json');
  const overview = JSON.parse(fs.readFileSync(filename)); overview.reference_coverage.cross_file++;
  const bytes = Buffer.from(JSON.stringify(overview)); fs.writeFileSync(filename, bytes);
  const manifestPath = path.join(ir.directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const artifact = manifest.artifacts.find(a => a.path === 'overview.json'); artifact.bytes = bytes.length; artifact.sha256 = hash(bytes);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyIR(ir.directory), /Derived overview mismatch/);
});

test('IR consistency checks source provenance and out-of-bounds line ranges', t => {
  const { ir } = fixture(t);
  mutate(ir.directory, 'occurrences', values => { values[1].range = [999, 0, 999, 1]; });
  assert.throws(() => verifyIR(ir.directory), /line out of bounds/);
  mutate(ir.directory, 'occurrences', values => { values[1].range = [2, 0, 2, 4]; values[1].source_sha256 = 'incorrect'; });
  assert.throws(() => verifyIR(ir.directory), /provenance mismatch/);
});

test('known UTF-16 encoding uses code units while unspecified encodings are reported separately', t => {
  const { ir } = fixture(t, { unicode: true });
  assert.equal(verifyIR(ir.directory).range_columns_unchecked_encoding_unspecified, 0);
  mutate(ir.directory, 'occurrences', values => { values[0].range = [0, 2, 0, 5]; });
  assert.throws(() => verifyIR(ir.directory), /column out of bounds/);
});

test('persisted code-ir/1 remains readable without upgrading or modifying old artifacts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-legacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const names = ['files', 'documents', 'symbols', 'occurrences', 'relationships', 'diagnostics', 'external-symbols'];
  const artifacts = [], counts = {};
  for (const name of names) {
    fs.writeFileSync(path.join(directory, name + '.jsonl'), '');
    artifacts.push({ path: name + '.jsonl', bytes: 0, sha256: hash(Buffer.alloc(0)) }); counts[name] = 0;
  }
  const manifest = { schema_version: 'code-ir/1', state: 'indexed', snapshot: { commit: 'legacy', root: '/no-longer-present' }, artifacts, counts };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(verifyIR(directory).schema_version, 'code-ir/1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')), manifest);
});
