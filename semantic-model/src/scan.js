import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { inventory, hash } from './inventory.js';
import { openStore, addInventory, importScip, setMetadata, summary } from './store.js';
import { persistIR, finalizeIR } from './ir.js';

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
  const db = openStore(path.join(runDir, 'model.sqlite'));
  try {
    addInventory(db, before);
    const runs = [];
    for (const language of languages) {
      const scip = path.join(runDir, `${language}.scip`), log = path.join(runDir, `${language}.log`);
      const entry = { indexer: language, cwd: root, log: path.basename(log), status: 'failed' };
      try {
        let args, cwd = root;
        const env = { ...process.env };
        if (language === 'python') {
          // Reuse installed packages for symbol resolution; never install target code.
          const scripts = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
          const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
          if (fs.existsSync(scripts)) env[pathKey] = `${scripts}${path.delimiter}${env[pathKey] || ''}`;
          const interpreter = python || path.join(scripts, process.platform === 'win32' ? 'python.exe' : 'python');
          entry.environment = fs.existsSync(interpreter) ? 'installed-packages' : 'empty-no-venv';
          const environmentFile = path.join(runDir, 'python-environment.json');
          // The indexer's pip discovery invokes python3 on Windows and can fall
          // back to hundreds of shell commands. Use its documented environment input.
          let packages = [];
          if (fs.existsSync(interpreter)) {
            const script = 'import importlib.metadata as m,json; print(json.dumps([dict(name=d.metadata["Name"],version=d.version,files=[str(f).replace(chr(92),"/") for f in (d.files or [])]) for d in m.distributions()]))';
            packages = JSON.parse(execFileSync(interpreter, ['-c', script], { cwd: root, env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));
          } else if (python) throw new Error(`Python interpreter does not exist: ${python}`);
          fs.writeFileSync(environmentFile, JSON.stringify(packages));
          args = [fileURLToPath(new URL('./run-python.cjs', import.meta.url)), 'index', '--cwd', root,
            '--project-name', path.basename(root), '--output', scip, '--environment', environmentFile];
        } else {
          if (!fs.existsSync(path.join(root, 'tsconfig.json')) && fs.existsSync(path.join(root, 'frontend', 'tsconfig.json'))) cwd = path.join(root, 'frontend');
          // Repository tsconfig include lists often omit server routes and tests.
          // An output-local overlay retains inherited compiler options and names
          // the inventoried sources explicitly, without editing the repository.
          const baseConfig = fs.existsSync(path.join(cwd, 'tsconfig.app.json')) ? path.join(cwd, 'tsconfig.app.json') : path.join(cwd, 'tsconfig.json');
          const config = path.join(runDir, 'tsconfig.index.json');
          const sources = before.files.filter(f => ['typescript', 'javascript'].includes(f.language)).map(f => path.join(root, f.path));
          fs.writeFileSync(config, JSON.stringify({
            ...(fs.existsSync(baseConfig) ? { extends: baseConfig } : {}),
            compilerOptions: { noEmit: true, allowJs: true, rootDir: root },
            files: sources, include: [], exclude: [], references: [],
          }, null, 2));
          entry.configuration = { mode: 'inventory-overlay', baseConfig: fs.existsSync(baseConfig) ? baseConfig : null, sourceFiles: sources.length, overlay: path.basename(config) };
          args = [require.resolve('@sourcegraph/scip-typescript'), 'index', config, '--cwd', root, '--output', scip, '--no-progress-bar'];
        }
        process.stderr.write(`Indexing ${language}: ${cwd}\n`);
        Object.assign(entry, { cwd, args: args.slice(1) });
        const result = await run(args, cwd, log, env, timeoutMs);
        Object.assign(entry, result);
        if (result.timedOut || result.code !== 0) throw new Error(`Indexer ${result.timedOut ? 'timed out' : `exited ${result.code}`}; see ${log}`);
        entry.artifactSha256 = hash(fs.readFileSync(scip));
        entry.stats = importScip(db, scip, root, language);
        entry.status = entry.stats.documents ? 'indexed' : 'empty';
      } catch (error) { entry.error = error.message; }
      runs.push(entry);
    }
    const after = inventory(root);
    let stable = before.fingerprint === after.fingerprint;
    let ir, persistenceError;
    if (stable && runs.some(r => r.status === 'indexed')) {
      try { ir = persistIR(runDir, before, runs); }
      catch (error) { persistenceError = error.message; }
      stable = stable && inventory(root).fingerprint === before.fingerprint;
    }
    const state = !stable ? 'source-changed' : persistenceError ? 'persistence-failed' : runs.every(r => r.status === 'indexed') ? 'indexed' : 'partial';
    if (ir) finalizeIR(ir.directory, state);
    if (ir) setMetadata(db, 'code_ir', { schema_version: ir.schema_version, directory: 'code-ir' });
    setMetadata(db, 'runs', runs);
    setMetadata(db, 'state', state);
    const report = { schemaVersion: 1, state, createdAt: new Date().toISOString(), sourceStable: stable,
      afterFingerprint: after.fingerprint, ir, persistenceError, ...summary(db) };
    fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    if (stable && ir && !persistenceError) {
      const temp = path.join(output, 'latest.json.tmp');
      fs.writeFileSync(temp, JSON.stringify({ runDir, state }, null, 2));
      fs.renameSync(temp, path.join(output, 'latest.json'));
    }
    return { runDir, ...report };
  } finally { db.close(); }
}
