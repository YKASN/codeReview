import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/check-local-install.mjs ABSOLUTE_CODEX_EXECUTABLE');
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'code-review-host-'));
const env = { ...process.env, CODEX_HOME: temporaryHome };
const run = args => execFileSync(binary, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
try {
  console.log(run(['plugin', 'marketplace', 'add', root, '--json']));
  console.log(run(['plugin', 'add', 'code-review@code-review-dev', '--json']));
  console.log(run(['plugin', 'list', '--marketplace', 'code-review-dev', '--json']));
  // Locate only this isolated test home's installed manifest; never edit cache.
  function manifests(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'output') return [];
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return manifests(full);
      return entry.name === 'mcp.json' ? [full] : [];
    });
  }
  const candidates = manifests(path.join(temporaryHome, 'plugins', 'cache'));
  const portable = candidates.find(f => JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers?.['code-review']);
  if (!portable) throw new Error('Installed portable MCP configuration not found');
  const pluginRoot = path.dirname(portable);
  const config = JSON.parse(fs.readFileSync(portable, 'utf8')).mcpServers['code-review'];
  const client = new Client({ name: 'installed-plugin-smoke', version: '0.2.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: config.args.map(a => a.replaceAll('${PLUGIN_ROOT}', pluginRoot)), cwd: pluginRoot, stderr: 'pipe' });
  let logs = ''; transport.stderr.on('data', bytes => { logs += bytes; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (tools.length !== 7) throw new Error('Installed tools were not discovered');
    const result = await client.callTool({ name: 'open_repository', arguments: { repository_path: root } });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    const report = { installed_by_codex_cli: true, installed_server_started: true, discovered_tools: tools.map(t => t.name), harmless_call: 'open_repository', user_profile_changed: false };
    const out = path.join(root, 'semantic-model', 'output', 'host-validation.json');
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) { throw new Error(`${error.message}\n${logs}`); }
  finally { await client.close(); }
} finally {
  // The absolute target was created by mkdtemp above, outside the project.
  if (!temporaryHome.startsWith(path.join(os.tmpdir(), 'code-review-host-'))) throw new Error('Unexpected cleanup target');
  fs.rmSync(temporaryHome, { recursive: true, force: true, maxRetries: 3 });
}
