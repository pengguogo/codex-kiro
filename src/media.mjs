import { GatewayError, transcript, mapTools } from './protocol.mjs';

// Codex embeds images in message content and in function/custom tool results.
// Keep a labelled placeholder in the role history, and send actual ACP image
// blocks separately. Never send base64 as model-readable prose.
export function acpPrompt(body, tools) {
  const images = [];
  const content = (parts) => {
    if (!Array.isArray(parts)) return parts;
    return parts.map((part) => {
      if (part?.type !== 'input_image') return part;
      const match = typeof part.image_url === 'string'
        && /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url);
      if (!match || match[2].length % 4 !== 0) {
        throw new GatewayError('Images must be embedded base64 PNG/JPEG/WebP/GIF data URLs. Remote URLs and OpenAI file IDs are not supported.', 400, 'unsupported_feature');
      }
      const label = `[Attached image ${images.length + 1}]`;
      images.push({ label, type: 'image', mimeType: match[1], data: match[2] });
      return { type: 'input_text', text: label };
    });
  };
  const input = typeof body.input === 'string' ? body.input : body.input.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const output = content(item.output);
      if (Array.isArray(output) && output.some((part) => !['input_text', 'output_text', 'text'].includes(part?.type))) {
        throw new GatewayError('Unsupported multimodal tool output. Only text and embedded images are supported.', 400, 'unsupported_feature');
      }
      return { ...item, output };
    }
    return item.content ? { ...item, content: content(item.content) } : item;
  });
  const prompt = [{ type: 'text', text: transcript({ ...body, input }, tools) }];
  for (const { label, ...image } of images) prompt.push({ type: 'text', text: label }, image);
  return prompt;
}

export function requestTools(body) {
  const tools = mapTools(body.tools);
  // A client tool search returns newly loaded tool definitions in history.
  // Some Codex versions also include these in tools[], so avoid double exposure.
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type !== 'tool_search_output' || item.execution !== 'client') continue;
      for (const [name, tool] of mapTools(item.tools || [])) {
        if (!tools.has(name)) tools.set(name, tool);
      }
    }
  }
  return tools;
}
