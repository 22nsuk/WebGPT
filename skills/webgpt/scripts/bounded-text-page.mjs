// Bound the complete serialized response, not just its source-text payload.
export const TEXT_PAGE_MAX_CHARS = 20000;
const boundary = (text, offset) => !(offset > 0 && offset < text.length
  && ((text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff)
    || (text[offset - 1] === '\r' && text[offset] === '\n')));

// Callers may measure their actual envelope, including nested JSON escaping.
// The default retains the parent CLI's JSON plus newline allowance.
export function boundedTextPage(content, offset, metadata, serialize = JSON.stringify) {
  if (!Number.isSafeInteger(offset) || offset < 0
      || (content.length ? offset >= content.length : offset !== 0) || !boundary(content, offset))
    throw RangeError('invalid text page offset');
  const page = end => ({ ...metadata, charUnit: 'UTF-16', startOffset: offset,
    endOffset: end, totalChars: content.length, nextOffset: end < content.length ? end : null,
    partial: offset !== 0 || end < content.length, content: content.slice(offset, end) });
  // Measure only safe prefixes: an escaped half-surrogate can cost more than
  // the completed pair. Search raw offsets so these equal-cost steps still advance.
  const fits = end => serialize(page(boundary(content, end) ? end : end - 1)).length + 2 <= TEXT_PAGE_MAX_CHARS;
  let low = offset, high = Math.min(content.length, offset + TEXT_PAGE_MAX_CHARS);
  // At EOF, nextOffset becomes null and can shrink metadata. Check that endpoint
  // before searching the otherwise increasing serialized prefixes.
  if (fits(high)) low = high;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (fits(end)) low = end;
    else high = end - 1;
  }
  while (!boundary(content, low)) low--;
  if ((content.length && low === offset) || !fits(low))
    throw RangeError('text page metadata exceeds output limit');
  return page(low);
}
