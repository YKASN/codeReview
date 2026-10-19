import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { inventory, hash } from './inventory.js';
import { openStore, addInventory, importScip, setMetadata, summary } from './store.js';
import { persistIR, finalizeIR } from './ir.js';
import { discoverProjects, writeTypeScriptOverlay } from './projects.js';
import { rebuildSQLite } from './projection.js';

const require = createRequire(import.meta.url);
function run(args, cwd, log, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(log, 'w');
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    let closed = false;
    const close = () => { clearTimeout(timer); if (!closed) { closed = true; fs.closeSync(fd); } };
    child.once('error', error => { close(); reject(error); });
    child.once('close', code => { close(); resolve({ code, timedOut }); });
  });
}

export async function scan(root, output, { languages = ['python', 'typescript'], timeoutMs = 10 * 60 * 1000, python } = {}) {
  const started = performance.now();
  root = fs.realpathSync(root); output = path.resolve(output);
  // Resolve existing parent links before creating an output directory.
  let ancestor = output;
  const remaining = [];
  while (!fs.existsSync(ancestor)) { remaining.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  output = path.join(fs.realpathSync(ancestor), ...remaining);
  const relative = path.relative(root, output);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Output must be outside analyzed repository');
  languages = [...new Set(languages)];
  if (!languages.length) throw new Error('Select at least one indexer');
  for (const language of languages) if (!['python', 'typescript'].includes(language)) throw new Error(`Unsupported indexer: ${language}`);
  fs.mkdirSync(output, { recursive: true });
  const before = inventory(root);
  const runDir = fs.mkdtempSync(path.join(output, 'scan-'));
  fs.writeFileSync(path.join(runDir, 'inventory.json'), JSON.stringify(before, null, 2));
  let db = openStore(path.join(runDir, 'model.sqlite'));
  try {
    addInventory(db, before);
    const catalog = discoverProjects(before, { python });
    const discovered = performance.now();
    fs.writeFileSync(path.join(runDir, 'projects.json'), JSON.stringify(catalog, null, 2));
    const runs = [], environments = new Map();
    for (const project of catalog.projects.filter(p => languages.includes(p.language) && p.files.length)) {
      const unitStarted = performance.now();
      const language = project.language;
      const key = project.id.replace(':', '-');
      const scip = path.join(runDir, key + '.scip'), log = path.join(runDir, key + '.log');
      const cwd = path.join(root, project.root);
      const entry = { id: key, project_id: project.id, indexer: language, cwd,
        artifact: path.basename(scip), log: path.basename(log), status: 'failed',
        configuration: project.configuration, limitations: project.limitations };
      try {
        if (project.configuration.diagnostics.length) throw new Error('Project configuration errors: ' + project.configuration.diagnostics.map(d => d.message).join('; '));
        let args;
        const env = { ...process.env };
        if (language === 'python') {
          const interpreter = project.environment.interpreter;
          entry.environment = project.environment;
          if (python && !project.environment.available) throw new Error('Python interpreter does not exist: ' + python);
          const environmentFile = path.join(runDir, key + '-environment.json');
          let packages = [];
          if (interpreter) {
            if (!environments.has(interpreter)) {
              const script = 'import importlib.metadata as m,json; print(json.dumps([dict(name=d.metadata["Name"],version=d.version,files=[str(f).replace(chr(92),"/") for f in (d.files or [])]) for d in m.distributions()]))';
              environments.set(interpreter, JSON.parse(execFileSync(interpreter, ['-c', script], { cwd: root, env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).toString('utf8')));
            }
            packages = environments.get(interpreter);
          }
          fs.writeFileSync(environmentFile, JSON.stringify(packages));
          args = [fileURLToPath(new URL('./run-python.cjs', import.meta.url)), 'index', '--cwd', cwd,
            '--project-name', path.basename(root) + ':' + project.root, '--project-version', before.commit,
            '--output', scip, '--environment', environmentFile];
          // 0.6.6 treats a file target as a project root and emits an empty
          // relative_path. Keep directory indexing and select catalog inputs
          // during import; preserve the complete original artifact for provenance.
          entry.document_selection = 'catalog-input-files';
        } else {
          const config = writeTypeScriptOverlay(runDir, root, project);
          entry.overlay = path.basename(config);
          args = [require.resolve('@sourcegraph/scip-typescript'), 'index', config, '--cwd', root, '--output', scip, '--no-progress-bar'];
        }
        process.stderr.write('Indexing ' + language + ' unit ' + project.root + ' (' + (project.configuration.path || 'inferred') + ')\n');
        entry.args = args.slice(1);
        const result = await run(args, cwd, log, env, timeoutMs);
        Object.assign(entry, result);
        if (result.timedOut || result.code !== 0) throw new Error('Indexer ' + (result.timedOut ? 'timed out' : 'exited ' + result.code) + '; see ' + log);
        entry.artifactSha256 = hash(fs.readFileSync(scip));
        entry.stats = importScip(db, scip, root, project.id, language === 'python' ? new Set(project.files) : null);
        entry.status = entry.stats.documents ? 'indexed' : 'empty';
      } catch (error) { entry.error = error.message; }
      entry.duration_ms = Math.round(performance.now() - unitStarted);
      runs.push(entry);
    }
    const indexed = performance.now();
    const after = inventory(root);
    let stable = before.fingerprint === after.fingerprint && hash(JSON.stringify(catalog)) === hash(JSON.stringify(discoverProjects(after, { python })));
    let ir, persistenceError;
    if (stable && runs.some(r => r.status === 'indexed')) {
      try { ir = persistIR(runDir, before, runs, catalog); }
      catch (error) { persistenceError = error.message; }
      const finalInventory = inventory(root);
      stable = stable && finalInventory.fingerprint === before.fingerprint && hash(JSON.stringify(catalog)) === hash(JSON.stringify(discoverProjects(finalInventory, { python })));
    }
    let state = !stable ? 'source-changed' : persistenceError ? 'persistence-failed' : runs.length && runs.every(r => r.status === 'indexed') ? 'indexed' : 'partial';
    if (ir) finalizeIR(ir.directory, state);
    let validation;
    if (ir && ['indexed', 'partial'].includes(state)) {
      try {
        db.close(); db = null;
        validation = rebuildSQLite(ir.directory, path.join(runDir, 'model.sqlite')).validation;
        db = openStore(path.join(runDir, 'model.sqlite'));
      }
      catch (error) {
        if (!db) db = openStore(path.join(runDir, 'model.sqlite'));
        persistenceError = error.message; state = 'persistence-failed'; finalizeIR(ir.directory, state);
      }
    }
    if (ir) setMetadata(db, 'code_ir', { schema_version: ir.schema_version, directory: 'code-ir', projection_version: validation ? 'code-ir-sqlite/2' : null });
    setMetadata(db, 'runs', runs);
    setMetadata(db, 'state', state);
    const report = { schemaVersion: 1, state, createdAt: new Date().toISOString(), sourceStable: stable,
      afterFingerprint: after.fingerprint, ir, validation, persistenceError,
      timings_ms: { discovery: Math.round(discovered - started), indexing: Math.round(indexed - discovered), persistence_and_validation: Math.round(performance.now() - indexed), total: Math.round(performance.now() - started) }, ...summary(db) };
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    if (stable && ir && !persistenceError) {
      const temp = path.join(output, 'latest.json.tmp');
      fs.writeFileSync(temp, JSON.stringify({ runDir, state }, null, 2));
      fs.renameSync(temp, path.join(output, 'latest.json'));
    }
    return { runDir, ...report };
  } finally { db?.close(); }
}
