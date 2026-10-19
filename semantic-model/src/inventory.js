import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const languages = { '.py': 'python', '.pyi': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.vue': 'vue', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.sql': 'sql', '.sh': 'shell', '.ps1': 'powershell', '.bat': 'batch', '.txt': 'text', '.css': 'css', '.html': 'html' };
const excluded = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.local-backups', '.data', 'outputs', 'output', 'dist', 'build', 'pytest-work']);

export function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes('\\')) throw new Error(`Invalid relative path: ${relative}`);
  if (relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Noncanonical path: ${relative}`);
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes repository: ${relative}`);
  // Reject symlinks in every component, including a directory symlink.
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink excluded: ${relative}`);
  }
  return full;
}

export function inventory(root) {
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const paths = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))].sort();
  const files = [], skipped = [];
  for (const relative of paths) {
    const name = path.posix.basename(relative);
    if (relative.split('/').some(p => excluded.has(p)) || /(^\.env($|\.)|credential|secret|\.pem$|\.key$|\.p12$)/i.test(name)) {
      skipped.push({ path: relative, reason: 'excluded' }); continue;
    }
    const language = languages[path.extname(relative).toLowerCase()];
    if (!language) { skipped.push({ path: relative, reason: 'unsupported-file-type' }); continue; }
    try {
      const full = inside(root, relative), stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 1024 * 1024) { skipped.push({ path: relative, reason: 'not-regular-or-over-1MiB' }); continue; }
      const bytes = fs.readFileSync(full);
      if (bytes.includes(0)) { skipped.push({ path: relative, reason: 'binary' }); continue; }
      files.push({ path: relative, language, sha256: hash(bytes), bytes: bytes.length });
    } catch (error) { skipped.push({ path: relative, reason: error.code || error.message }); }
  }
  return { root, commit: git(['rev-parse', 'HEAD']).toString().trim(), dirty: git(['status', '--porcelain', '-z']).length > 0,
    fingerprint: hash(JSON.stringify(files)), files, skipped };
}
