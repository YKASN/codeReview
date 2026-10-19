import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inventory, inside, hash } from '../src/inventory.js';
import { Index, openStore, addInventory, importScip, rangeOf } from '../src/store.js';
import { scan } from '../src/scan.js';
import { persistIR, finalizeIR, verifyIR } from '../src/ir.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'Fixture']);
  fs.writeFileSync(path.join(root, 'a.py'), 'from b import run\nrun()\n');
  fs.writeFileSync(path.join(root, 'b.py'), 'def run():\n    return 1\n');
  return root;
}
const occurrence = (symbol, line, roles = 0) => ({ symbol, range: [line, 0, 3], symbolRoles: roles });
function index(root, documents) {
  const f = path.join(root, 'fixture.scip');
  fs.writeFileSync(f, Index.encode(Index.fromObject({ metadata: { projectRoot: pathToFileURL(root).href }, documents })).finish());
  return f;
}

test('SCIP links cross-file references, scopes locals, and retains late symbol documentation', t => {
  const root = fixture(t), db = openStore(':memory:'); t.after(() => db.close());
  addInventory(db, inventory(root));
  const symbol = 'scip-python python fixture 1 b/run().';
  const f = index(root, [
    { relativePath: 'a.py', occurrences: [occurrence(symbol, 1), occurrence('local 0', 0, 1)] },
    { relativePath: 'b.py', positionEncoding: 2, symbols: [{ symbol, displayName: 'run', documentation: ['Runs a task.'] }], occurrences: [occurrence(symbol, 0, 1), occurrence('local 0', 1, 1)] },
  ]);
  const stats = importScip(db, f, root, 'python');
  assert.equal(stats.documents, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM occurrences WHERE symbol=?').get(symbol).n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM symbols WHERE raw='local 0'").get().n, 2);
  const result = db.prepare('SELECT * FROM symbols WHERE id=?').get(symbol);
  assert.equal(result.name, 'run');
  assert.deepEqual(JSON.parse(result.documentation), ['Runs a task.']);

});

test('Windows indexer paths normalize without permitting traversal', t => {
  const root = fixture(t), db = openStore(':memory:'); t.after(() => db.close());
  fs.mkdirSync(path.join(root, 'nested')); fs.writeFileSync(path.join(root, 'nested', 'c.py'), 'x=1\n');
  addInventory(db, inventory(root));
  const result = importScip(db, index(root, [{ relativePath: 'nested\\c.py', occurrences: [occurrence('local 0', 0, 1)] }]), root, 'python');
  assert.equal(result.normalizedWindowsPaths, 1);
  assert.equal(db.prepare('SELECT path FROM documents').get().path, 'nested/c.py');
  assert.throws(() => importScip(db, index(root, [{ relativePath: '..\\outside.py' }]), root, 'second'), /Noncanonical/);
});

test('inventory excludes secrets, ignored files and deleted tracked paths', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.py\n');
  fs.writeFileSync(path.join(root, 'ignored.py'), 'x=1');
  fs.writeFileSync(path.join(root, '.env.local'), 'TOKEN=private');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'x.py'), 'x=1');
  execFileSync('git', ['-C', root, 'add', 'a.py']); fs.unlinkSync(path.join(root, 'a.py'));
  const result = inventory(root);
  assert.deepEqual(result.files.map(f => f.path), ['b.py']);
  assert.ok(result.skipped.some(f => f.path === 'a.py' && f.reason === 'ENOENT'));
  assert.throws(() => inside(root, '../outside.py'), /Noncanonical/);
  assert.throws(() => inside(root, 'a/../b.py'), /Noncanonical/);
});

test('import rolls back malformed documents and rejects roots outside repository', t => {
  const root = fixture(t), db = openStore(':memory:'); t.after(() => db.close());
  addInventory(db, inventory(root));
  assert.throws(() => importScip(db, index(root, [{ relativePath: 'a.py' }, { relativePath: '../bad.py' }]), root, 'python'), /Noncanonical/);
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get().n, 0);
  assert.throws(() => importScip(db, index(path.dirname(root), []), root, 'python'), /outside repository/);
  fs.unlinkSync(path.join(path.dirname(root), 'fixture.scip'));
});

test('range normalization supports legacy and typed ranges', () => {
  assert.deepEqual(rangeOf({ range: [1, 2, 3] }), [1, 2, 1, 3]);
  assert.deepEqual(rangeOf({ singleLineRange: { line: 3, startCharacter: 2, endCharacter: 4 }, range: [0, 0, 1] }), [3, 2, 3, 4]);
  assert.deepEqual(rangeOf({ multiLineRange: { startLine: 0, startCharacter: 1, endLine: 2, endCharacter: 3 } }), [0, 1, 2, 3]);
  assert.throws(() => rangeOf({ range: [1, 0] }), /Invalid/);
  assert.throws(() => rangeOf({ singleLineRange: { line: 0, startCharacter: 3, endCharacter: 1 } }), /Invalid/);
});

test('real scip-python indexes a two-file repository on this platform', async t => {
  const root = fixture(t), output = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-output-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const report = await scan(root, output, { languages: ['python'], timeoutMs: 60000 });
  assert.equal(report.state, 'indexed', JSON.stringify(report.runs));
  assert.equal(report.indexedFiles, 2);
  assert.equal(verifyIR(report.ir.directory).valid, true);
  const fileReferences = fs.readFileSync(path.join(report.ir.directory, 'file-references.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(fileReferences.some(r => r.kind === 'symbol-reference' && r.evidence.length > 0 && r.source_file_id !== r.target_file_id));
  const db = openStore(path.join(report.runDir, 'model.sqlite'));
  try {
    const symbol = db.prepare('SELECT symbol id FROM occurrences GROUP BY symbol HAVING sum(roles & 1)>0 AND count(DISTINCT path)>1').get();
    assert.ok(symbol, 'A resolved symbol must have a definition and a cross-file reference');
    assert.equal(db.prepare('SELECT count(DISTINCT path) n FROM occurrences WHERE symbol=?').get(symbol.id).n, 2);
  } finally { db.close(); }
});

test('real scip-typescript indexes cross-file imports', async t => {
  const root = fixture(t), output = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-ts-output-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }));
  fs.writeFileSync(path.join(root, 'a.ts'), 'import { run } from "./b";\nrun();\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export function run() { return 1; }\n');
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(path.join(root, 'server', 'extra.ts'), 'export const extra = 42;\n');
  const report = await scan(root, output, { languages: ['typescript'], timeoutMs: 60000 });
  assert.equal(report.state, 'indexed', JSON.stringify(report.runs));
  assert.equal(report.indexedFiles, 3);
  assert.equal(verifyIR(report.ir.directory).counts.documents, 3);
  const calls = fs.readFileSync(path.join(report.ir.directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const call = calls.find(c => c.callee_name === 'run');
  assert.equal(call.resolution_status, 'resolved-static');
  const definitions = fs.readFileSync(path.join(report.ir.directory, 'structures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(definitions.some(s => s.kind === 'function' && s.name === 'run' && s.symbol_id === call.target_symbol_id));
  const relationPath = path.join(report.ir.directory, 'file-references.jsonl');
  const relations = fs.readFileSync(relationPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(relations.some(r => r.symbol_ids.includes(call.target_symbol_id) && r.evidence.some(e => call.binding_occurrence_ids.includes(e.occurrence_id))));
  const forged = structuredClone(relations);
  forged[0].evidence[0].definition_ids = [call.binding_occurrence_ids[0]];
  const bytes = Buffer.from(forged.map(r => JSON.stringify(r) + '\n').join(''));
  fs.writeFileSync(relationPath, bytes);
  const manifestPath = path.join(report.ir.directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const artifact = manifest.artifacts.find(a => a.path === 'file-references.jsonl'); artifact.bytes = bytes.length; artifact.sha256 = hash(bytes);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyIR(report.ir.directory), /File reference evidence mismatch/);
  const db = openStore(path.join(report.runDir, 'model.sqlite'));
  try {
    const symbol = db.prepare('SELECT symbol id FROM occurrences GROUP BY symbol HAVING sum(roles & 1)>0 AND count(DISTINCT path)>1').get();
    assert.ok(symbol);
    assert.equal(db.prepare('SELECT count(DISTINCT path) n FROM occurrences WHERE symbol=?').get(symbol.id).n, 2);
  } finally { db.close(); }
});

test('scan rejects writes inside target repository and unsupported indexers', async t => {
  const root = fixture(t);
  await assert.rejects(scan(root, path.join(root, 'output')), /outside analyzed repository/);
  await assert.rejects(scan(root, path.join(root, '..', 'unused-output'), { languages: ['unknown'] }), /Unsupported indexer/);
});

test('source context rejects a symlinked directory', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'real'));
  fs.writeFileSync(path.join(root, 'real', 'file.py'), 'x=1\n');
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inside(root, 'linked/file.py'), /Symlink excluded/);
});

test('scan rejects an output alias pointing inside the source repository', async t => {
  const root = fixture(t), parent = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-alias-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const alias = path.join(parent, 'alias');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scan(root, path.join(alias, 'new-output')), /outside analyzed repository/);
  assert.equal(fs.existsSync(path.join(root, 'new-output')), false);
});

test('Python preparation failure is recorded and does not publish latest', async t => {
  const root = fixture(t), output = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-failed-output-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const report = await scan(root, output, { languages: ['python'], python: path.join(root, 'missing-python') });
  assert.equal(report.state, 'partial');
  assert.equal(report.runs[0].status, 'failed');
  assert.match(report.runs[0].error, /interpreter does not exist/);
  assert.equal(fs.existsSync(path.join(output, 'latest.json')), false);
});

test('persisted IR retains producer ranges, relationships, diagnostics and external symbols', t => {
  const root = fixture(t), output = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-records-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const source = inventory(root), symbol = 'scip-python python fixture 1 b/run().';
  fs.writeFileSync(path.join(output, 'python.scip'), Index.encode(Index.fromObject({
    metadata: { projectRoot: pathToFileURL(root).href },
    documents: [{ relativePath: 'b.py', symbols: [{ symbol, relationships: [{ symbol: 'external#', isImplementation: true }] }],
      occurrences: [{ symbol, range: [0, 4, 7], enclosingRange: [0, 0, 1, 12], symbolRoles: 1, diagnostics: [{ message: 'Example diagnostic', severity: 2 }] },
        { range: [1, 0, 4], diagnostics: [{ message: 'Unresolved occurrence' }] }] }],
    externalSymbols: [{ symbol: 'external#', documentation: ['External symbol docs'] }],
  })).finish());
  const ir = persistIR(output, source, [{ indexer: 'python', status: 'indexed' }]);
  assert.throws(() => verifyIR(ir.directory), /not finalized/);
  finalizeIR(ir.directory, 'indexed');
  assert.equal(verifyIR(ir.directory).valid, true);
  const rows = name => fs.readFileSync(path.join(ir.directory, name + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows('occurrences')[0].raw.enclosingRange, [0, 0, 1, 12]);
  assert.equal(rows('occurrences')[1].symbol_id, null);
  assert.equal(rows('relationships')[0].raw.isImplementation, true);
  assert.equal(rows('diagnostics').length, 2);
  assert.equal(rows('external-symbols')[0].producer_symbol, 'external#');
  assert.equal(rows('symbols').find(s => s.producer_symbol === symbol).resolution_status, 'defined');
  assert.equal(rows('relationships')[0].target_symbol_id, rows('external-symbols')[0].symbol_id);
});

test('IR verifies in a new process without the original repository and detects damaged source blobs', async t => {
  const root = fixture(t), output = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-offline-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const report = await scan(root, output, { languages: ['python'], timeoutMs: 60000 });
  assert.equal(report.state, 'indexed');
  fs.renameSync(root, path.join(output, 'moved-original'));
  const modulePath = new URL('../src/ir.js', import.meta.url).href;
  const code = `import {verifyIR} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(verifyIR(process.argv[1])));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, report.ir.directory], { encoding: 'utf8' }));
  assert.equal(result.valid, true);
  const file = JSON.parse(fs.readFileSync(path.join(report.ir.directory, 'files.jsonl'), 'utf8').split('\n')[0]);
  assert.match(fs.readFileSync(path.join(report.ir.directory, file.source), 'utf8'), /from b import run/);
  fs.appendFileSync(path.join(report.ir.directory, file.source), '# corruption\n');
  assert.throws(() => verifyIR(report.ir.directory), /checksum mismatch/);
});
