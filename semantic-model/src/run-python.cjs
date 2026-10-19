// scip-python 0.6.6 treats Windows' path separator as an unescaped regex.
// Patch only the pinned bundle in memory; never modify installed/source files.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const entry = require.resolve('@sourcegraph/scip-python');
const bundle = path.join(path.dirname(entry), 'dist', 'scip-python.js');
const original = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (process.platform !== 'win32' || filename !== bundle) return original(mod, filename);
  const source = fs.readFileSync(filename, 'utf8');
  const needle = 'new RegExp(o.sep,"g")';
  if (source.split(needle).length !== 2) throw new Error('Unsupported scip-python bundle; review Windows compatibility shim');
  mod._compile(source.replace(needle, String.raw`new RegExp(o.sep === "\\" ? "\\\\" : o.sep,"g")`), filename);
};
require(entry);
