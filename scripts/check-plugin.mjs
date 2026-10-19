import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../semantic-model/package.json', import.meta.url));
const { parse } = require('yaml');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const portable = read('plugin.json'), compatibility = read('.codex-plugin/plugin.json');
assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.match(portable.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.match(portable.version, /^\d+\.\d+\.\d+$/);
assert.equal(portable.name, compatibility.name);
assert.equal(portable.version, compatibility.version);
assert.deepEqual(portable.extensions['com.openai'].interface, compatibility.interface);
assert.ok(portable.extensions['com.openai'].interface.shortDescription.length <= 30);
assert.equal(portable.extensions['com.openai'].requires_local_executor, true);
const mcp = read('mcp.json'), legacy = read('.mcp.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
for (const [name, server] of Object.entries(mcp.mcpServers)) {
  assert.equal(server.type, 'stdio');
  const { type, ...same } = server;
  assert.deepEqual(same, legacy.mcpServers[name]);
  assert.equal(server.command, 'node');
  const entry = server.args[0].replace('${PLUGIN_ROOT}/', '');
  assert.ok(fs.existsSync(path.join(root, entry)));
}
const names = new Set();
for (const directory of fs.readdirSync(path.join(root, 'skills'))) {
  const text = fs.readFileSync(path.join(root, 'skills', directory, 'SKILL.md'), 'utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, `${directory} requires YAML frontmatter`);
  const value = parse(frontmatter[1]);
  assert.equal(value.name, directory);
  assert.equal(typeof value.description, 'string'); assert.ok(value.description.trim());
  assert.ok(!names.has(value.name)); names.add(value.name);
}
assert.equal(read('.agents/plugins/marketplace.json').plugins[0].name, portable.name);
console.log(JSON.stringify({ valid: true, plugin: portable.name, version: portable.version, skills: [...names], mcpServers: Object.keys(mcp.mcpServers) }));
