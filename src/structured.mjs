import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { GatewayError } from './protocol.mjs';

export function structuredFormat(body) {
  const format = body.text?.format;
  if (!format || format.type === 'text') return null;
  const schema = format.type === 'json_object' ? { type: 'object' } : format.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new GatewayError('json_schema requires an object schema.', 400, 'invalid_request');
  }
  let validate;
  try {
    const Validator = schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
    // Unknown constraints fail rather than being silently ignored. No coercion,
    // default insertion, or removal of fields is allowed, especially for reviews.
    const ajv = new Validator({ strict: true, strictTypes: false, strictRequired: false,
      strictTuples: false, allowUnionTypes: true });
    validate = ajv.compile(schema);
  } catch {
    throw new GatewayError('Unsupported or invalid JSON Schema constraints.', 400, 'unsupported_feature');
  }
  return {
    instruction: `\nFinal response format: return only JSON matching this schema, without markdown, commentary or invented fields. Tool calls may precede the final answer. Schema: ${JSON.stringify(schema)}`,
    validateText(text) {
      let value;
      try { value = JSON.parse(text); } catch {
        throw new GatewayError('Kiro final response is not valid JSON.', 502, 'invalid_structured_output');
      }
      if (!validate(value)) throw new GatewayError('Kiro final response does not match the requested JSON Schema.', 502, 'invalid_structured_output');
      return text;
    },
  };
}
