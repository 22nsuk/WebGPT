// Shared complete-line windows for project snapshots and explicitly supplied text.
// Character budgets count UTF-16 code units, including original line endings.
export const windowProperties = {
  offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum: 5000 },
  maxChars: { type: 'integer', minimum: 1, maximum: 200000 },
};
export function readWindowOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !Object.hasOwn(windowProperties, key))) throw Error('invalid read options');
  const { offset = 1, limit = 400, maxChars = 16000 } = options;
  const range = { offset, limit, maxChars };
  for (const [name, value] of Object.entries(range)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > windowProperties[name].maximum)
      throw Error(`invalid read ${name}`);
  }
  return Object.values(options).some(value => value !== undefined) ? range : null;
}
// Callers validate options before acquiring their snapshot. Selection cannot
// authorize a file access or turn an excerpt's hash into a whole-source revision.
export function textWindow(text, { offset, limit, maxChars }, source = 'file') {
  let totalLines = 0, endLine = offset - 1, characters = 0, stopped = false;
  const parts = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    totalLines++;
    if (totalLines < offset || stopped) continue;
    if (parts.length === limit) { stopped = true; continue; }
    if (characters + match[0].length > maxChars) {
      if (parts.length === 0) throw Error(`first requested line exceeds maxChars; increase maxChars or read the whole ${source}`);
      stopped = true; continue;
    }
    parts.push(match[0]); characters += match[0].length; endLine = totalLines;
  }
  if (offset > Math.max(1, totalLines)) throw Error(`read offset is beyond the ${source}`);
  return { text: parts.join(''), partial: offset !== 1 || endLine < totalLines,
    startLine: offset, endLine, totalLines, nextOffset: endLine < totalLines ? endLine + 1 : null };
}
