export const MAX_WORDS_PER_TEXT_SECTION = 120;

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function chunkTextByWords(
  text: string,
  maxWords = MAX_WORDS_PER_TEXT_SECTION,
): string[] {
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new Error("maxWords must be a positive integer.");
  }

  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const words = normalized.split(" ");
  const chunks: string[] = [];

  for (let start = 0; start < words.length; start += maxWords) {
    chunks.push(words.slice(start, start + maxWords).join(" "));
  }

  return chunks;
}
