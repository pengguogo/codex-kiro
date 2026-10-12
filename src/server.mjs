import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AcpClient } from './acp.mjs';
import { discoverModels, modelEnvelope, upstreamModelId } from './models.mjs';
import { GatewayError, id, mapTools, transcript, validateRequest, ResponseWriter } from './protocol.mjs';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new GatewayError('Request too large.', 413, 'invalid_request');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new GatewayError('Invalid JSON.', 400, 'invalid_request'); }
}
function authorized(req, key) {
  const sent = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export function createGateway({ key, command = 'kiro-cli', args = ['acp', '--agent-engine=v2', '--agent', 'codex-bridge'],
  timeoutMs = 180000, model = 'auto' } = {}) {
  if (!key) throw new Error('Set KIRO_GATEWAY_KEY to a local gateway password.');
  const bridges = new Map();
  const active = new Set();
  let closed = false;
  let catalogue;
  let catalogueTime = 0;
  let discovery;
  const server = http.createServer(async (req, res) => {
    let writer;
    let client;
    let token;
    let timeout;
    let heartbeat;
    let onClose;
    const requestId = id('req');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/mcp/')) {
        const bridge = bridges.get(url.pathname.slice(5));
        if (!bridge) return json(res, 404, { error: 'Unknown MCP session' });
        if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
        if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
        const rpc = await readJson(req);
        if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
        let result;
        if (rpc.method === 'initialize') result = {
          protocolVersion: rpc.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} }, serverInfo: { name: 'codex-tools', version: '0.1.0' },
        };
        else if (rpc.method === 'ping') result = {};
        else if (rpc.method === 'tools/list') result = { tools: [...bridge.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        else if (rpc.method === 'tools/call') {
          const tool = bridge.tools.get(rpc.params?.name);
          if (!tool) return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unknown tool' } });
          const rawArguments = rpc.params.arguments ?? {};
          const arguments_ = tool.wrapped ? rawArguments.arguments : rawArguments;
          if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
            return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Tool arguments must be an object' } });
          }
          // End this model step at the first tool request. Codex executes it; the next
          // stateless Responses request supplies the result in its full transcript.
          bridge.onTool(tool, arguments_);
          result = { isError: true, content: [{ type: 'text', text: 'Tool handed off to Codex. This ACP turn is ending.' }] };
        } else return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'ok', backend: 'kiro-cli-acp', version: '0.2.0', active_requests: active.size,
          authenticated: 'not checked; use doctor/live smoke test' });
      }
      if (!authorized(req, key)) return json(res, 401, { error: { code: 'unauthorized', message: 'Local gateway key required.' } });
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return json(res, 200, { backend: 'kiro-cli-acp', version: '0.2.0' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (!catalogue || Date.now() - catalogueTime > 60000 || url.searchParams.get('refresh') === '1') {
          discovery ??= discoverModels(command, args, Math.min(timeoutMs, 60000)).then((models) => {
            catalogue = modelEnvelope(models); catalogueTime = Date.now(); return catalogue;
          }).finally(() => { discovery = null; });
          await discovery;
        }
        return json(res, 200, catalogue);
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/responses') {
        return json(res, 404, { error: { code: 'not_found', message: 'Use POST /v1/responses.' } });
      }
      if (closed) throw new GatewayError('Server shutting down.', 503);
      const body = await readJson(req);
      validateRequest(body);
      const tools = mapTools(body.tools);
      if (body.tool_choice === 'none') tools.clear();
      const prompt = transcript(body);
      const requestedModel = body.model || model;
      if (typeof requestedModel !== 'string' || !requestedModel) throw new GatewayError('Invalid model.', 400, 'invalid_request');
      const selectedModel = upstreamModelId(requestedModel);
      if (typeof selectedModel !== 'string' || !selectedModel) throw new GatewayError('Invalid model.', 400, 'invalid_request');
      writer = new ResponseWriter(res, requestedModel, body.stream === true);
      let done = false;
      let resolveTurn, rejectTurn;
      const turn = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      token = id('mcp');
      bridges.set(token, { tools, onTool(tool, args_) {
        if (done) return;
        try {
          writer.tool(tool, args_);
          done = true;
          resolveTurn();
        } catch (error) { done = true; rejectTurn(error); }
      } });
      client = new AcpClient(command, args, (msg) => {
        if (done) return;
        if (!['session/update', 'session/notification', '_kiro.dev/session/update'].includes(msg.method)) return;
        const update = msg.params?.update || msg.params;
        const kind = String(update?.sessionUpdate || update?.type || '').replaceAll('_', '').toLowerCase();
        if (kind === 'agentmessagechunk' && update.content?.type === 'text') writer.text(update.content.text);
      }, [...tools.keys()], body.instructions || '');
      active.add(client);
      writer.start();
      const heartbeatMs = Math.min(15000, timeoutMs);
      heartbeat = setInterval(() => { if (body.stream && !res.destroyed) res.write(': keepalive\n\n'); }, heartbeatMs);
      onClose = () => { if (!res.writableEnded) rejectTurn(new GatewayError('Client disconnected.', 499, 'cancelled')); };
      res.on('close', onClose);
      const work = (async () => {
        await client.start();
        const session = await client.call('session/new', { cwd: client.cwd, mcpServers: tools.size ? [{
          type: 'http', name: 'codex', url: `http://127.0.0.1:${server.address().port}/mcp/${token}`, headers: [],
        }] : [] });
        if (!session?.sessionId) throw new GatewayError('ACP returned no sessionId.');
        if (selectedModel !== 'auto') {
          const available = session.models?.availableModels;
          if (!Array.isArray(available)) throw new GatewayError('Kiro returned no model catalogue.', 502, 'model_catalog_unavailable');
          if (!available.some((model) => model.modelId === selectedModel)) {
            throw new GatewayError(`Unknown model: ${selectedModel}. Refresh /v1/models.`, 400, 'unknown_model');
          }
          await client.call('session/set_model', { sessionId: session.sessionId, modelId: selectedModel });
        }
        const result = await client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
        if (!done) {
          if (result?.stopReason && result.stopReason !== 'end_turn') {
            throw new GatewayError(`Kiro stopped with ${result.stopReason}.`, 502, 'kiro_stop');
          }
          done = true;
          resolveTurn();
        }
      })();
      work.catch((error) => { if (!done) rejectTurn(error); });
      timeout = setTimeout(() => rejectTurn(new GatewayError('Kiro ACP timed out. Check login, model access and MCP connectivity.', 504, 'timeout')), timeoutMs);
      await turn;
      done = true;
      await client.stop();
      writer.finish();
      console.error(`[${requestId}] completed backend=kiro-cli model=${selectedModel} tools=${writer.output.filter((x) => x.type.endsWith('call')).length}`);
    } catch (error) {
      console.error(`[${requestId}] failed code=${error.code || 'internal_error'}`);
      if (writer && !res.destroyed) writer.fail(error);
      else if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: { code: error.code || 'internal_error', message: error.message } });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (onClose) res.off('close', onClose);
      if (token) bridges.delete(token);
      if (client) { await client.stop(); active.delete(client); }
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.shutdown = async () => {
    closed = true;
    await Promise.all([...active].map((client) => client.stop()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGateway({ key: process.env.KIRO_GATEWAY_KEY, command: process.env.KIRO_CLI_PATH,
    model: process.env.KIRO_MODEL, timeoutMs: Number(process.env.KIRO_TIMEOUT_MS || 180000) });
  server.listen(Number(process.env.KIRO_GATEWAY_PORT || 8765), '127.0.0.1', () => {
    console.error(`Codex → Kiro gateway: http://127.0.0.1:${server.address().port} (no OpenAI fallback)`);
  });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.shutdown(); process.exit(); });
}
