import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import TOML from '@iarna/toml';
import { hash, inside } from './inventory.js';

const slash = value => value.split(path.sep).join('/');
const under = (file, directory) => directory === '.' || file === directory || file.startsWith(directory + '/');
const directoryOf = file => path.posix.dirname(file);
const idFor = (language, key) => 'project:' + hash(JSON.stringify([language, key])).slice(0, 24);
const tsLanguage = file => ['typescript', 'javascript'].includes(file.language);

export function discoverProjects(snapshot, { python } = {}) {
  const files = new Map(snapshot.files.map(f => [f.path, f]));
  const projects = [], membership = Object.fromEntries(snapshot.files.map(f => [f.path, []]));
  const relative = absolute => slash(path.relative(snapshot.root, absolute));
  const add = project => {
    projects.push(project);
    for (const file of project.files) membership[file].push(project.id);
    return project;
  };
  const pythonEnvironment = directory => {
    if (python) return { interpreter: path.resolve(python), origin: 'explicit', available: fs.existsSync(python) };
    let current = path.join(snapshot.root, directory);
    while (true) {
      const interpreter = path.join(current, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (fs.existsSync(interpreter)) return { interpreter, origin: 'nearest-ancestor-venv', available: true };
      if (current === snapshot.root) break;
      current = path.dirname(current);
    }
    return { interpreter: null, origin: 'none', available: false };
  };

  // Use TypeScript's own JSONC/config resolver, including extends and references.
  const tsConfigs = snapshot.files.filter(f => /(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/.test(f.path));
  for (const config of tsConfigs) {
    const absolute = inside(snapshot.root, config.path), configReads = [], diagnostics = [];
    const read = filename => {
      const content = ts.sys.readFile(filename);
      if (content !== undefined) configReads.push({ path: relative(filename), sha256: hash(Buffer.from(content)), external: !files.has(relative(filename)) });
      return content;
    };
    const loaded = ts.readConfigFile(absolute, read);
    const parsed = ts.parseJsonConfigFileContent(loaded.config || {}, { ...ts.sys, readFile: read }, path.dirname(absolute), undefined, absolute);
    for (const error of [loaded.error, ...parsed.errors].filter(Boolean)) diagnostics.push({ code: error.code, message: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
    const selected = [...new Set(parsed.fileNames.map(relative).filter(p => files.has(p) && tsLanguage(files.get(p))))].sort();
    add({ id: idFor('typescript', config.path), language: 'typescript', root: directoryOf(config.path),
      kind: parsed.projectReferences?.length && !selected.length ? 'solution' : !selected.length ? 'configuration' : 'configured',
      configuration: { path: config.path, sha256: config.sha256, resolver: `typescript/${ts.version}`,
        reads: configReads, declared: loaded.config || {}, effective_options: parsed.options,
        references: (parsed.projectReferences || []).map(r => relative(r.path)), diagnostics },
      environment: { dependency_installation: 'existing-only' }, files: selected,
      limitations: diagnostics.length ? ['configuration-diagnostics'] : [] });
  }
  // Unassigned files stay separate and explicitly inferred, not forced through
  // an unrelated client/server tsconfig. Group by package and first source folder.
  const packages = snapshot.files.filter(f => path.posix.basename(f.path) === 'package.json').map(f => directoryOf(f.path));
  const fallback = new Map();
  for (const file of snapshot.files.filter(tsLanguage)) {
    if (membership[file.path].length) continue;
    const owner = packages.filter(p => under(file.path, p)).sort((a, b) => (b === '.' ? 0 : b.length) - (a === '.' ? 0 : a.length))[0] || '.';
    const local = owner === '.' ? file.path : file.path.slice(owner.length + 1);
    const first = local.split('/');
    const group = first.length > 1 ? (owner === '.' ? first[0] : owner + '/' + first[0]) : owner;
    if (!fallback.has(group)) fallback.set(group, []);
    fallback.get(group).push(file.path);
  }
  for (const [root, selected] of fallback) add({ id: idFor('typescript', 'inferred:' + root), language: 'typescript', root,
    kind: 'inferred', configuration: { path: null, resolver: `typescript/${ts.version}`, declared: {}, effective_options: {}, references: [], diagnostics: [] },
    environment: { dependency_installation: 'existing-only' }, files: selected,
    limitations: ['no-config-selects-these-files', 'compiler-defaults-not-project-configuration'] });

  const pyFiles = snapshot.files.filter(f => f.language === 'python');
  const configNames = new Set(['pyproject.toml', 'pyrightconfig.json', 'setup.cfg', 'setup.py']);
  const pyDescriptors = snapshot.files.filter(f => configNames.has(path.posix.basename(f.path)) || /^requirements[^/]*\.txt$/.test(path.posix.basename(f.path)));
  const pyRoots = new Set(pyDescriptors.map(f => directoryOf(f.path)));
  // Top-level components are identified as inferred units when no local project
  // metadata exists. Do not execute app.py/setup.py to discover sys.path changes.
  for (const file of pyFiles) pyRoots.add(file.path.includes('/') ? file.path.split('/')[0] : '.');
  for (const root of [...pyRoots].sort()) {
    const selected = pyFiles.filter(f => [...pyRoots].filter(p => under(f.path, p)).sort((a, b) => (b === '.' ? 0 : b.length) - (a === '.' ? 0 : a.length))[0] === root).map(f => f.path);
    if (!selected.length) continue;
    const descriptors = pyDescriptors.filter(f => directoryOf(f.path) === root);
    const configuration = { path: null, descriptors: descriptors.map(f => ({ path: f.path, sha256: f.sha256 })), declared: {}, diagnostics: [] };
    const pyproject = descriptors.find(f => path.posix.basename(f.path) === 'pyproject.toml');
    const pyright = descriptors.find(f => path.posix.basename(f.path) === 'pyrightconfig.json');
    configuration.path = pyright?.path || pyproject?.path || null;
    configuration.sha256 = pyright?.sha256 || pyproject?.sha256 || null;
    try {
      if (pyproject) {
        const parsed = TOML.parse(fs.readFileSync(inside(snapshot.root, pyproject.path), 'utf8').replace(/^\uFEFF/, ''));
        configuration.path = pyproject.path;
        configuration.declared = parsed.tool?.pyright || {};
        configuration.package = parsed.project || {};
      }
      if (pyright) {
        const parsed = ts.parseConfigFileTextToJson(pyright.path, fs.readFileSync(inside(snapshot.root, pyright.path), 'utf8'));
        if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
        configuration.path = pyright.path; configuration.declared = parsed.config;
      }
    } catch (error) { configuration.diagnostics.push({ message: error.message }); }
    configuration.import_paths = (configuration.declared.extraPaths || []).map(p => slash(path.resolve(snapshot.root, root, p)));
    add({ id: idFor('python', root), language: 'python', root, kind: configuration.path ? 'configured' : 'inferred',
      configuration, environment: pythonEnvironment(root), files: selected,
      limitations: [...(!configuration.path ? ['no-static-import-path-configuration'] : []),
        'runtime-sys-path-changes-not-executed', ...(descriptors.some(f => /setup\.(?:cfg|py)$/.test(f.path)) ? ['packaging-config-not-executed'] : [])] });
  }
  return { projects: projects.sort((a, b) => a.id.localeCompare(b.id)), membership,
    file_status: Object.fromEntries(snapshot.files.map(file => [file.path,
      !['python', 'typescript', 'javascript'].includes(file.language) ? 'source-only-unsupported-language' : membership[file.path].length ? 'assigned' : 'unassigned'])) };
}

export function writeTypeScriptOverlay(runDir, root, project) {
  const filename = path.join(runDir, `${project.id.replace(':', '-')}.tsconfig.json`);
  const configuration = project.configuration.path;
  fs.writeFileSync(filename, JSON.stringify({ ...(configuration ? { extends: inside(root, configuration) } : {}),
    compilerOptions: { noEmit: true, allowJs: true, rootDir: root },
    files: project.files.map(f => path.join(root, f)), include: [], exclude: [], references: [] }, null, 2));
  return filename;
}
