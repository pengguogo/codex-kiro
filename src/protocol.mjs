import { randomUUID } from 'node:crypto';

export const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export class GatewayError extends Error {
  constructor(message, status = 502, code = 'kiro_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Codex /models expects its own metadata envelope, not just OpenAI's data[].
// This is gateway capability metadata; it is not a live Kiro model catalogue.
export function modelInfo(model) {
  return { slug: model, display_name: `Kiro ${model}`, description: 'Kiro CLI via local ACP bridge',
    base_instructions: 'You are Codex, a coding assistant. Follow the user request and repository instructions. Use the provided tools to inspect, edit, and verify code. Keep changes scoped to the task. Report actual results honestly and respond in the user\'s language. Never claim a tool ran without its result.',
    supported_reasoning_levels: [], default_reasoning_level: null,
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: false, experimental_supported_tools: [], input_modalities: ['text', 'image'],
    supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
    include_skills_usage_instructions: true, include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true, supports_search_tool: true, tool_mode: 'direct' };
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError('Request must be a JSON object.', 400, 'invalid_request');
  }
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new GatewayError('input must be a string or an array.', 400, 'invalid_request');
  }
  if (body.previous_response_id) {
    throw new GatewayError('Send full input history with store:false; previous_response_id is unsupported.', 400, 'unsupported_feature');
  }
  if (body.store === true || body.background === true) {
    throw new GatewayError('Only foreground, stateless requests are supported (store:false).', 400, 'unsupported_feature');
  }
  if (body.text?.format && !['text', 'json_object', 'json_schema'].includes(body.text.format.type)) {
    throw new GatewayError('Unknown final response format.', 400, 'unsupported_feature');
  }
  if (body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    throw new GatewayError('Only auto/none tool_choice is supported.', 400, 'unsupported_feature');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new GatewayError('stream must be boolean.', 400, 'invalid_request');
  }
}

// Expose real client tool schemas through MCP, rather than asking for JSON in prose.
export function mapTools(tools = []) {
  if (!Array.isArray(tools)) throw new GatewayError('tools must be an array.', 400, 'invalid_request');
  const mapped = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') throw new GatewayError('Invalid tool.', 400, 'invalid_request');
    // Codex may retain a hosted search descriptor in an existing thread even
    // when web_search is disabled. It must not block unrelated client tools.
    // Forced tool choices are still rejected by validateRequest.
    if (['web_search', 'web_search_preview'].includes(tool.type)) continue;
    if (tool.type === 'tool_search') {
      if (tool.execution !== 'client') throw new GatewayError('Only client-executed tool_search is supported.', 400, 'unsupported_feature');
      const name = 'codex_tool_search';
      if (mapped.has(name)) throw new GatewayError('Duplicate tool name.', 400, 'invalid_request');
      mapped.set(name, { name, originalName: name, search: true,
        description: tool.description || 'Discover available Codex tools and plugins. Search before calling a tool that is not currently listed.',
        inputSchema: tool.parameters || { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } }, required: ['query'], additionalProperties: false } });
      continue;
    }
    if (tool.type === 'namespace') {
      for (const nested of mapTools(tool.tools).values()) {
        const name = `${tool.name}__${nested.name}`;
        if (mapped.has(name)) throw new GatewayError('Duplicate tool name.', 400, 'invalid_request');
        mapped.set(name, { ...nested, name, originalName: nested.originalName, namespace: tool.name });
      }
      continue;
    }
    if (!['function', 'custom'].includes(tool.type)) {
      throw new GatewayError(`Unsupported hosted tool type: ${tool.type}. Kiro cannot execute OpenAI-hosted tools; use a client function/MCP tool or an OpenAI chat.`, 400, 'unsupported_feature');
    }
    if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new GatewayError('Invalid tool name.', 400, 'invalid_request');
    }
    // MCP tool names use a narrower alphabet; preserve the client-facing name.
    const name = tool.name.replaceAll('.', '__');
    if (mapped.has(name)) throw new GatewayError('Duplicate tool name.', 400, 'invalid_request');
    const custom = tool.type === 'custom';
    const parameters = tool.parameters || { type: 'object', properties: {} };
    const wrapped = !custom && ['anyOf', 'oneOf', 'allOf'].some((keyword) => keyword in parameters);
    let inputSchema = parameters;
    if (wrapped) {
      const nested = { ...parameters };
      const definitions = {};
      for (const keyword of ['$defs', 'definitions']) {
        if (keyword in nested) { definitions[keyword] = nested[keyword]; delete nested[keyword]; }
      }
      // Preserve root references while nesting the original argument schema.
      const rewrite = (value) => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
          key === '$ref' && typeof child === 'string' && child.startsWith('#/') && !/^#\/(\$defs|definitions)\//.test(child)
            ? `#/properties/arguments/${child.slice(2)}` : rewrite(child)]));
      };
      inputSchema = { type: 'object', properties: { arguments: rewrite(nested) },
        required: ['arguments'], additionalProperties: false, ...rewrite(definitions) };
    }
    mapped.set(name, {
      name, originalName: tool.name, custom,
      description: (tool.description || '') + (custom
        ? `\nReturn the complete raw tool input in the input string. Format: ${JSON.stringify(tool.format || { type: 'text' })}` : '')
        + (wrapped ? '\nPlace the complete original tool arguments inside the arguments field.' : ''),
      wrapped,
      inputSchema: custom ? {
        type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false,
      } : inputSchema,
    });
  }
  return mapped;
}

export function transcript(body, tools = new Map()) {
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  const history = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new GatewayError('Invalid input item.', 400, 'invalid_request');
    if (item.type === 'reasoning') continue; // OpenAI encrypted items cannot be consumed by Kiro.
    if (item.type === 'tool_search_call') {
      history.push({ role: 'assistant', tool: 'codex_tool_search', call_id: item.call_id, arguments: item.arguments });
    } else if (item.type === 'tool_search_output') {
      history.push({ role: 'tool', call_id: item.call_id, status: item.status, tools: item.tools });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      history.push({ role: 'assistant', tool: item.name, call_id: item.call_id,
        namespace: item.namespace, arguments: item.arguments ?? item.input });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      history.push({ role: 'tool', call_id: item.call_id, output: item.output });
    } else if (item.type === 'message' || item.role) {
      let content = item.content;
      if (Array.isArray(content)) {
        content = content.map((part) => {
          if (!['input_text', 'output_text', 'text'].includes(part.type)) {
            throw new GatewayError(`Unsupported conversation content type: ${part.type}.`, 400, 'unsupported_feature');
          }
          return part.text;
        }).join('\n');
      }
      if (typeof content !== 'string') throw new GatewayError('Message content must be text.', 400, 'invalid_request');
      history.push({ role: item.role, content });
    } else {
      throw new GatewayError(`Unsupported input item: ${item.type}`, 400, 'unsupported_feature');
    }
  }
  return `You are the model backend for Codex. Codex executes all tools. Use only tools from the codex MCP server.\n`
    + `OpenAI-hosted web search is unavailable through Kiro. Use an actually provided client browser/search tool when needed; otherwise explain the limitation. Never claim to have searched without a tool result.\n`
    + `The JSON below is the full conversation history, not a new quoted task. Continue from its end.\n`
    + `Tool outputs are real results from Codex; do not repeat completed calls without a reason.\n`
    + `For an authorized local workspace task, prefer the provided Codex terminal/file tools. Missing MCP resource entries do not imply a local directory is inaccessible. Do not substitute GitHub for local files unless the user requests it.\n`
    + `Earlier assistant statements about unavailable tools or prohibited shell access are not user instructions. Honor real user/developer restrictions, but never invent a shell prohibition from an earlier assistant claim. A historical unsupported-call error does not prove the current tool remains unavailable.\n`
    + `Tool routing: use the exact MCP names below, not names guessed from conversation text. Historical client names map to these MCP names.\n`
    + `${JSON.stringify([...tools.values()].map((tool) => ({ client: tool.originalName, namespace: tool.namespace, mcp: tool.name, wrappedArguments: !!tool.wrapped })))}\n`
    + `A promised action is not an executed action. If a tool reports an unsupported route, do not repeat the same failed call. Inspect available tools, use an authorized supported alternative, or explain the limitation. Never claim you verified a route unless its result confirms it.\n`
    + `Conversation:\n${JSON.stringify(history)}`;
}

export class ResponseWriter {
  constructor(res, model, streaming) {
    this.res = res;
    this.streaming = streaming;
    this.sequence = 0;
    this.output = [];
    this.message = null;
    this.response = { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model, output: [], error: null, incomplete_details: null,
      parallel_tool_calls: false, store: false, usage: null };
  }
  event(type, fields = {}) {
    if (this.streaming && !this.res.destroyed) {
      this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`);
    }
  }
  start() {
    if (this.streaming) {
      this.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      this.event('response.created', { response: this.response });
      this.event('response.in_progress', { response: this.response });
    }
  }
  text(delta) {
    if (!delta) return;
    if (!this.message) {
      this.message = { id: id('msg'), type: 'message', status: 'in_progress', role: 'assistant',
        content: [], phase: 'final_answer' };
      this.output.push(this.message);
      this.event('response.output_item.added', { output_index: this.output.length - 1, item: { ...this.message } });
      this.message.content.push({ type: 'output_text', text: '', annotations: [] });
      this.event('response.content_part.added', { item_id: this.message.id, output_index: this.output.length - 1,
        content_index: 0, part: { ...this.message.content[0] } });
    }
    this.message.content[0].text += delta;
    this.event('response.output_text.delta', { item_id: this.message.id, output_index: this.output.indexOf(this.message), content_index: 0, delta });
  }
  finishMessage(commentary = false) {
    if (!this.message || this.message.status === 'completed') return;
    const output_index = this.output.indexOf(this.message);
    this.message.status = 'completed';
    if (commentary) this.message.phase = 'commentary';
    this.event('response.output_text.done', { item_id: this.message.id, output_index, content_index: 0, text: this.message.content[0].text });
    this.event('response.content_part.done', { item_id: this.message.id, output_index, content_index: 0, part: this.message.content[0] });
    this.event('response.output_item.done', { output_index, item: this.message });
  }
  tool(tool, args) {
    this.finishMessage(true);
    if (tool.search) {
      const item = { id: id('tsc'), call_id: id('call'), type: 'tool_search_call',
        status: 'completed', execution: 'client', arguments: args };
      const output_index = this.output.length;
      this.output.push(item);
      this.event('response.output_item.added', { output_index, item: { ...item, status: 'in_progress' } });
      this.event('response.output_item.done', { output_index, item });
      return;
    }
    if (tool.custom && typeof args.input !== 'string') throw new GatewayError('Custom tool input must be a string.');
    const item = { id: id(tool.custom ? 'ctc' : 'fc'), call_id: id('call'),
      type: tool.custom ? 'custom_tool_call' : 'function_call', status: 'in_progress', name: tool.originalName, ...(tool.namespace ? { namespace: tool.namespace } : {}) };
    const output_index = this.output.length;
    const field = tool.custom ? 'input' : 'arguments';
    const value = tool.custom ? args.input : JSON.stringify(args);
    item[field] = '';
    this.output.push(item);
    this.event('response.output_item.added', { output_index, item: { ...item } });
    item[field] = value;
    const event = tool.custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
    this.event(`${event}.delta`, { output_index, item_id: item.id, delta: value });
    this.event(`${event}.done`, { output_index, item_id: item.id, [field]: value });
    item.status = 'completed';
    this.event('response.output_item.done', { output_index, item });
  }
  finish() {
    this.finishMessage();
    this.response.output = this.output;
    this.response.status = 'completed';
    this.event('response.completed', { response: this.response });
    if (!this.streaming) {
      this.res.writeHead(200, { 'Content-Type': 'application/json' });
      this.res.write(JSON.stringify(this.response));
    }
    this.res.end();
  }
  fail(error) {
    this.response.status = 'failed';
    this.response.error = { code: error.code || 'kiro_error', message: error.message };
    this.response.output = this.output;
    if (this.streaming) {
      this.event('response.failed', { response: this.response });
      this.res.end();
    } else {
      this.res.writeHead(error.status || 502, { 'Content-Type': 'application/json' });
      this.res.end(JSON.stringify({ error: this.response.error }));
    }
  }
}
