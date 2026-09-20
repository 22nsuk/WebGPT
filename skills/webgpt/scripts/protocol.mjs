// The file worker's small, stateless JSON-RPC boundary; no browser or shell transport.
export const protocolVersions = Object.freeze(['2025-03-26', '2025-06-18']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateMessage(message) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method
      || (Object.hasOwn(message, 'params') && !record(message.params)))
    throw Error('invalid JSON-RPC request');
  if (!Object.hasOwn(message, 'id')) {
    // Notifications must never be mistaken for tool requests with side effects.
    if (!message.method.startsWith('notifications/')) throw Error('request ID required');
    return 'notification';
  }
  if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))
      || message.method.startsWith('notifications/')) throw Error('invalid request ID or method');
  return 'request';
}

export function negotiateProtocol(requested) {
  // Keep the original minimal local initialize probe working.
  if (requested === undefined) return protocolVersions[0];
  if (typeof requested !== 'string') throw Error('protocolVersion must be a string');
  return protocolVersions.includes(requested) ? requested : protocolVersions.at(-1);
}

export function validateArguments(tool, args) {
  if (!record(args)) throw Error('tool arguments must be an object');
  const { properties, required } = tool.inputSchema;
  if (required.some(key => !Object.hasOwn(args, key))) throw Error('required tool argument missing');
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) throw Error('unexpected tool argument');
    const rule = properties[key], types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const correctType = types.some(type => type === 'null' ? value === null
      : type === 'integer' ? Number.isSafeInteger(value)
      : type === 'string' ? typeof value === 'string' && value.isWellFormed()
      : type === 'boolean' ? typeof value === 'boolean' : false);
    if (!correctType || (rule.enum && !rule.enum.includes(value))
        || (rule.minimum !== undefined && value < rule.minimum)
        || (rule.maximum !== undefined && value > rule.maximum))
      throw Error('invalid tool argument value');
  }
}
