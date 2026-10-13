import { createInterface } from 'node:readline';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let mcp;
let sid = 'fake-session';
const callMcp = async (method, params = {}) => {
  const res = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return res.json();
};
createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: !process.argv.includes('--no-images') } }, agentInfo: { name: 'fake-kiro' } } });
  else if (msg.method === 'session/new') {
    mcp = msg.params.mcpServers[0];
    if (mcp) await callMcp('initialize', { protocolVersion: '2024-11-05' });
    send({ id: msg.id, result: { sessionId: sid, ...(process.argv.includes('--no-catalogue') ? {} : { models: { currentModelId: 'auto', availableModels: [
      { modelId: 'auto', name: 'Auto' }, { modelId: 'claude-test', name: 'Claude Test' },
      { modelId: 'gpt-test', name: 'GPT Test' },
    ] } }) } });
  } else if (msg.method === 'session/set_model') {
    if (msg.params.modelId.startsWith('kiro/')) throw new Error('Public prefix leaked to Kiro');
    if (msg.params.modelId === 'bad-model') send({ id: msg.id, error: { code: -32602, message: 'Unknown model' } });
    else send({ id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const prompt = msg.params.prompt[0].text;
    const content = (text) => send({ method: 'session/update', params: { sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    if (prompt.includes('HANG')) return;
    if (prompt.includes('STRUCTURED_FIXTURE')) {
      content(prompt.includes('INVALID_JSON') ? '```json\n{"decision":"deny"}\n```' :
        prompt.includes('WRONG_SCHEMA') ? '{"decision":"unexpected"}' : '{"decision":"deny"}');
      send({ id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (prompt.includes('MEDIA_FIXTURE')) {
      const images = msg.params.prompt.filter((part) => part.type === 'image');
      if (!images.length || prompt.includes(images[0].data)) throw new Error('Image bytes must be a real ACP image block, not text');
      content(`Received ${images.length} image blocks: ${images[0].mimeType}`);
      send({ id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (prompt.includes('NATIVE_PERMISSION')) {
      send({ id: 999, method: 'session/request_permission', params: { sessionId: sid, toolCall: { title: 'shell' },
        options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
      return;
    }
    if (prompt.includes('CUSTOM_ARGS_FIXTURE')) {
      const listed = await callMcp('tools/list');
      const tool = listed.result.tools[0];
      const cases = { missing: {}, object: { input: { private_value: 'DO_NOT_LOG_SECRET' } },
        number: { input: 42 }, array: [], raw: 'DO_NOT_LOG_SECRET', extra: { input: 'raw', extra: 'DO_NOT_LOG_SECRET' } };
      const match = /CUSTOM_ARGS_FIXTURE:(\w+)/.exec(prompt);
      for (let i = 0; i < (prompt.includes('EXHAUST') ? 4 : 1); i++) {
        const result = await callMcp('tools/call', { name: tool.name, arguments: cases[match?.[1]] || {} });
        if (!result.result?.isError || !result.result.content[0].text.includes('Correct the arguments')) throw new Error('Invalid arguments did not return a retryable MCP tool error');
      }
      await callMcp('tools/call', { name: tool.name, arguments: { input: '*** Begin Patch\n*** End Patch' } });
      return;
    }
    const alreadyDone = prompt.includes('"role":"tool"');
    if (mcp && (!alreadyDone || prompt.includes('SEARCH_FIXTURE'))) {
      const listed = await callMcp('tools/list');
      const tool = listed.result.tools.find((t) => t.name === 'exec_command') || listed.result.tools[0];
      if (tool) {
        content('正在调用工具。');
        await callMcp('tools/call', { name: tool.name, arguments: tool.name === 'codex_tool_search'
          ? { query: 'image generation', limit: 2 } : tool.name === 'union_tool'
          ? { arguments: { action: 'list' } } : tool.name === 'apply_patch'
          ? { input: '*** Begin Patch\n*** End Patch' }
          : { cmd: 'printf kiro-tool-ok', max_output_tokens: 1000 } });
        return;
      }
    }
    content(alreadyDone ? '工具结果已收到：' : 'Kiro ');
    content(alreadyDone ? 'kiro-tool-ok' : 'OK');
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
