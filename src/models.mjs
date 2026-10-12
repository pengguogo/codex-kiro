import { AcpClient } from './acp.mjs';
import { GatewayError, modelInfo } from './protocol.mjs';

export const publicModelId = (model) => `kiro/${model}`;
export const upstreamModelId = (model) => model.startsWith('kiro/') ? model.slice(5) : model;

export async function discoverModels(command = 'kiro-cli', args = ['acp', '--agent-engine=v2', '--agent', 'codex-bridge'], timeoutMs = 60000) {
  const client = new AcpClient(command, args, () => {});
  let timer;
  try {
    const work = (async () => {
      await client.start();
      const session = await client.call('session/new', { cwd: client.cwd, mcpServers: [] });
      const models = session?.models?.availableModels;
      if (!Array.isArray(models) || !models.length) throw new GatewayError('Kiro returned no model catalogue.', 502, 'model_catalog_unavailable');
      const unique = new Map();
      for (const model of models) {
        if (typeof model.modelId !== 'string' || !model.modelId) continue;
        unique.set(model.modelId, { id: model.modelId, name: model.name || model.modelId, description: model.description || '' });
      }
      if (!unique.size) throw new GatewayError('Invalid Kiro model catalogue.', 502, 'model_catalog_unavailable');
      return [...unique.values()];
    })();
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new GatewayError('Kiro model discovery timed out.', 504, 'timeout')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); await client.stop(); }
}

export function modelEnvelope(models) {
  return { object: 'list', source: 'kiro-cli-acp', data: models.map((model) => ({
    id: publicModelId(model.id), upstream_id: model.id, object: 'model', created: 0, owned_by: 'kiro',
  })), models: models.map((model) => ({ ...modelInfo(publicModelId(model.id)),
    display_name: `Kiro · ${model.name}`, description: model.description })) };
}
