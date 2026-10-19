import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { discoverProjects } from '../src/projects.js';
import { inventory } from '../src/inventory.js';
import { scan } from '../src/scan.js';
import { verifyIR } from '../src/ir.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'Fixture']);
  const write = (file, text) => { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
  return { root, write };
}

test('project discovery respects JSONC extends, references, config membership and inferred gaps', t => {
  const { root, write } = fixture(t);
  write('package.json', '{"name":"fixture","version":"1.0.0"}');
  write('tsconfig.base.json', '{ "compilerOptions": { "strict": true, "target": "ES2022" }, "files": [] }');
  write('tsconfig.json', '{ "files": [], "references": [{"path":"./client"},{"path":"./server"}] }');
  write('client/tsconfig.json', '{ // client config\n "extends":"../tsconfig.base.json", "include":["*.ts"], "compilerOptions":{"lib":["ES2022","DOM"]} }');
  write('server/tsconfig.json', '{ "extends":"../tsconfig.base.json", "include":["*.ts"], "compilerOptions":{"lib":["ES2022"]} }');
  write('client/app.ts', 'export const client = document.title;\n');
  write('server/main.ts', 'export const server = 1;\n');
  write('tests/extra.ts', 'export const extra = 2;\n');
  const catalog = discoverProjects(inventory(root));
  const client = catalog.projects.find(p => p.configuration.path === 'client/tsconfig.json');
  const server = catalog.projects.find(p => p.configuration.path === 'server/tsconfig.json');
  assert.deepEqual(client.files, ['client/app.ts']);
  assert.deepEqual(server.files, ['server/main.ts']);
  assert.notDeepEqual(client.configuration.effective_options.lib, server.configuration.effective_options.lib);
  assert.equal(client.configuration.effective_options.strict, true);
  assert.ok(client.configuration.reads.some(r => r.path === 'tsconfig.base.json'));
  const solution = catalog.projects.find(p => p.configuration.path === 'tsconfig.json');
  assert.equal(solution.kind, 'solution');
  assert.deepEqual(solution.configuration.references, ['client', 'server']);
  const inferred = catalog.projects.find(p => p.files.includes('tests/extra.ts'));
  assert.equal(inferred.kind, 'inferred'); assert.equal(inferred.configuration.path, null);
  assert.ok(inferred.limitations.includes('no-config-selects-these-files'));
});

test('Python components have independent static config, nearest venv metadata and explicit uncertainty', t => {
  const { root, write } = fixture(t);
  write('app.py', 'from a import value\n');
  write('a/main.py', 'value = 1\n');
  write('a/pyproject.toml', '[project]\nname="a"\n[tool.pyright]\nextraPaths=["src"]\n');
  write('b/main.py', 'value = 2\n');
  write('b/pyrightconfig.json', '{"extraPaths":["lib"],"include":["."]}');
  write('c/main.py', 'raise RuntimeError("This must never execute")\n');
  const catalog = discoverProjects(inventory(root));
  const a = catalog.projects.find(p => p.root === 'a');
  const b = catalog.projects.find(p => p.root === 'b');
  const c = catalog.projects.find(p => p.root === 'c');
  assert.deepEqual(a.files, ['a/main.py']); assert.equal(a.kind, 'configured');
  assert.equal(a.configuration.package.name, 'a');
  assert.equal(a.configuration.import_paths[0], path.join(root, 'a', 'src').split(path.sep).join('/'));
  assert.deepEqual(b.files, ['b/main.py']); assert.equal(b.configuration.path, 'b/pyrightconfig.json');
  assert.equal(c.kind, 'inferred'); assert.equal(c.environment.available, false);
  assert.ok(c.limitations.includes('runtime-sys-path-changes-not-executed'));
  assert.equal(catalog.projects.find(p => p.root === '.').files.length, 1);
});

test('malformed Python project configuration is recorded instead of silently treating it as valid', t => {
  const { root, write } = fixture(t);
  write('main.py', 'x=1\n'); write('pyproject.toml', 'invalid = [');
  const project = discoverProjects(inventory(root)).projects[0];
  assert.equal(project.kind, 'configured'); assert.equal(project.configuration.diagnostics.length, 1);
});

test('real TS units preserve different configurations, serialize normalized IDs and capture fallback membership', async t => {
  const { root, write } = fixture(t);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-project-output-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  write('package.json', '{"name":"fixture","version":"1.0.0"}');
  write('client/tsconfig.json', '{"compilerOptions":{"target":"ES2022","module":"ESNext","strict":true},"include":["*.ts"]}');
  write('server/tsconfig.json', '{"compilerOptions":{"target":"ES2022","module":"CommonJS"},"include":["*.ts"]}');
  write('client/main.ts', 'export function run() { return 1; }\nrun();\n');
  write('server/main.ts', 'export function run() { return 2; }\nrun();\n');
  write('tests/check.ts', 'export const checked = true;\n');
  const report = await scan(root, output, { languages: ['typescript'], timeoutMs: 60000 });
  assert.equal(report.state, 'indexed', JSON.stringify(report));
  assert.equal(report.runs.length, 3);
  const read = name => fs.readFileSync(path.join(report.ir.directory, name + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const projects = read('projects'), files = read('files');
  assert.notEqual(projects.find(p => p.root === 'client').configuration.effective_options.module, projects.find(p => p.root === 'server').configuration.effective_options.module);
  const fallbackFile = files.find(f => f.path === 'tests/check.ts');
  assert.equal(projects.find(p => p.id === fallbackFile.project_ids[0]).kind, 'inferred');
  assert.equal(fallbackFile.analysis_status, 'indexed');
  const symbols = read('symbols');
  assert.equal(new Set(symbols.map(s => s.id)).size, symbols.length);
  assert.ok(symbols.some(s => s.resolution_status === 'defined'));
  assert.ok(symbols.every(s => s.name !== undefined && s.kind && s.producer_symbol));
  const calls = read('calls');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.resolution_status === 'resolved-static' && c.binding_occurrence_ids.length && c.target_symbol_id));
  assert.ok(read('structures').some(s => s.kind === 'function' && s.name === 'run' && s.symbol_id));
  assert.equal(verifyIR(report.ir.directory).entity_links_verified, true);
});

test('invalid configuration produces a partial snapshot with per-file failure reasons', async t => {
  const { root, write } = fixture(t);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-partial-output-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  write('package.json', '{"name":"fixture","version":"1.0.0"}');
  write('good/tsconfig.json', '{"include":["*.ts"]}'); write('good/main.ts', 'export const good = 1;\n');
  write('bad/tsconfig.json', '{"compilerOptions":{"target":"invalid"},"include":["*.ts"]}'); write('bad/main.ts', 'export const bad = 1;\n');
  const report = await scan(root, output, { languages: ['typescript'], timeoutMs: 60000 });
  assert.equal(report.state, 'partial');
  const files = fs.readFileSync(path.join(report.ir.directory, 'files.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const failed = files.find(f => f.path === 'bad/main.ts');
  assert.equal(failed.analysis_status, 'failed');
  assert.match(failed.parse_results[0].reason, /configuration errors/i);
  assert.equal(verifyIR(report.ir.directory).valid, true);
});

test('single root Python file and nested components are indexed without invalid file-target paths or duplicate ownership', async t => {
  const { root, write } = fixture(t);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-python-units-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  write('app.py', 'from component.main import value\nprint(value)\n');
  write('component/main.py', 'value = 1\n');
  const report = await scan(root, output, { languages: ['python'], timeoutMs: 60000 });
  assert.equal(report.state, 'indexed', JSON.stringify(report.runs));
  assert.equal(report.runs.length, 2);
  assert.equal(report.ir.counts.documents, 2);
  assert.equal(report.indexedFiles, 2);
  const files = fs.readFileSync(path.join(report.ir.directory, 'files.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(files.every(f => f.document_ids.length === 1 && f.project_ids.length === 1));
});
