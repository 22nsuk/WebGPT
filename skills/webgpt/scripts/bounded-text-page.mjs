// Bound the complete serialized response, not just its source-text payload.
export const TEXT_PAGE_MAX_CHARS = 20000;
const boundary = (text, offset) => !(offset > 0 && offset < text.length
  && ((text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff)
    || (text[offset - 1] === '\r' && text[offset] === '\n')));

export function boundedTextPage(content, offset, metadata) {
  if (!Number.isSafeInteger(offset) || offset < 0
      || (content.length ? offset >= content.length : offset !== 0) || !boundary(content, offset))
    throw RangeError('invalid text page offset');
  const page = end => ({ ...metadata, charUnit: 'UTF-16', startOffset: offset,
    endOffset: end, totalChars: content.length, nextOffset: end < content.length ? end : null,
    partial: offset !== 0 || end < content.length, content: content.slice(offset, end) });
  let low = offset, high = Math.min(content.length, offset + TEXT_PAGE_MAX_CHARS);
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (JSON.stringify(page(end)).length + 2 <= TEXT_PAGE_MAX_CHARS) low = end;
    else high = end - 1;
  }
  while (!boundary(content, low)) low--;
  if ((content.length && low === offset) || JSON.stringify(page(low)).length + 2 > TEXT_PAGE_MAX_CHARS)
    throw RangeError('text page metadata exceeds output limit');
  return page(low);
}
