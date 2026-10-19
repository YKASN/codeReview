import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [repository, indexPath, output] = process.argv.slice(2);
if (!repository || !indexPath || !output) throw new Error('Usage: node scripts/chat-permission-case.mjs REPOSITORY INDEX_PATH OUTPUT_JSON');
const client = new Client({ name: 'chat-permission-acceptance', version: '0.2.0' });
await client.connect(new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/mcp-server.js', import.meta.url))], stderr: 'inherit' }));
const calls = [];
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  calls.push({ tool: name, arguments: args, result: result.structuredContent });
  return result.structuredContent;
}
try {
  const { repository_id } = await call('open_repository', { repository_path: path.resolve(repository), index_path: path.resolve(indexPath) });
  const status = await call('repository_status', { repository_id });
  if (!status.fresh) throw new Error('Acceptance requires a fresh index. Reindex the repository first.');
  const stages = [
    ['requireOwnedChat(', 'frontend/server/routes/api/chats/'],
    ['async function requireOwnedChat', 'frontend/server/utils/chatAccess.ts'],
    ['chat/retrieval/stream', 'frontend/server/'],
    ['/chat/retrieval/stream', 'agent/agent/api/'],
    ['def stream_chat', 'agent/agent/agent.py'],
    ['get_accessible_doc_ids_strict', 'agent/agent/service/permission_service.py'],
    ['allowed_documents', 'agent/agent/'],
  ];
  const seen = new Set();
  for (const [query, path_prefix] of stages) {
    const found = await call('search_source', { repository_id, query, path_prefix, limit: 8 });
    for (const match of found.matches.slice(0, 3)) {
      if (seen.has(match.citation)) continue;
      seen.add(match.citation);
      await call('read_context', { repository_id, file: match.path, line: match.startLine, radius: 15 });
    }
  }
  const symbols = await call('search_symbols', { repository_id, query: 'get_accessible_doc_ids_strict', limit: 50 });
  const symbol = symbols.matches.find(s => s.definitions > 0 && s.id.endsWith('get_accessible_doc_ids_strict().'));
  if (symbol) await call('get_symbol_evidence', { repository_id, symbol_id: symbol.id, limit: 5, radius: 8 });
  for (const [file, line, radius] of [
    ['frontend/server/routes/api/chats/[id].post.ts', 38, 37],
    ['agent/agent/api/internal_memory_routes.py', 218, 20],
    ['agent/agent/api/access_routes.py', 22, 16],
    ['agent/agent/agent.py', 622, 30],
    ['agent/agent/service/permission_service.py', 111, 28],
  ]) await call('read_context', { repository_id, file, line, radius });
  const final = await call('repository_status', { repository_id });
  if (!final.fresh) throw new Error('Source changed while collecting acceptance evidence.');
  const report = { created_at: new Date().toISOString(), case: 'chat-request-to-permission-check',
    runtime_validation: 'passed', semantic_verdict: 'requires Codex review of saved verified source', calls };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: path.resolve(output), calls: calls.length, verified_contexts: calls.filter(c => c.tool === 'read_context').length, symbol_found: Boolean(symbol) }));
} finally { await client.close(); }
