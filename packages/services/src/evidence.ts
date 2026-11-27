import type { Value } from "@repo/drizzle";

type Candidate = {
  field: string;
  value?: unknown;
  quote?: unknown;
  reason?: unknown;
};

export function validateValues(
  fields: readonly { field: string }[],
  candidates: Candidate[],
  text: string,
): Value[] {
  const sourceLines = text.split("\n");
  return fields.map(({ field }) => {
    const matches = candidates.filter(
      (candidate) => candidate && candidate.field === field,
    );
    const item = matches[0];
    const gap = (reason: string): Value => ({
      field,
      value: null,
      quote: null,
      reason,
    });
    if (matches.length > 1)
      return gap("Conflicting extractions for this field");
    if (typeof item?.value !== "string" || !item.value.trim())
      return gap(
        typeof item?.reason === "string" && item.reason.trim()
          ? item.reason
          : "Field not found in this version",
      );
    const quote = resolveQuote(item.quote, text, sourceLines);
    if (quote === null)
      return gap("Quoted evidence does not appear verbatim in this version");
    return { field, value: item.value, quote, reason: null };
  });
}

// The prompt presents each source line as "N\ttext". A model may copy that
// annotation along with the evidence. Resolve it only against that exact line.
function resolveQuote(
  quote: unknown,
  text: string,
  lines: string[],
): string | null {
  if (typeof quote !== "string" || !quote.trim()) return null;
  if (text.includes(quote)) return quote;
  const match = /^([1-9]\d*)\t([^\n]+)$/.exec(quote);
  if (!match) return null;
  const line = lines[Number(match[1]) - 1];
  return line?.trim() && line === match[2] ? line : null;
}

// The model proposes topic boundaries as line numbers. Slice the original lines so
// neither invented chunks nor omitted passages can enter the index.
export function segmentText(text: string, starts: number[]): string[] {
  const lines = text.split("\n");
  const offsets = [
    ...new Set([
      1,
      ...starts.filter(
        (i) => Number.isInteger(i) && i > 1 && i <= lines.length,
      ),
    ]),
  ].sort((a, b) => a - b);
  const sections: string[] = [];
  for (const [i, start] of offsets.entries()) {
    const section = lines
      .slice(start - 1, (offsets[i + 1] ?? lines.length + 1) - 1)
      .join("\n");
    // Bound embedding input even if a single line or section is exceptionally long.
    for (let pos = 0; pos < section.length; pos += 3000) {
      const chunk = section.slice(pos, pos + 3000);
      if (chunk.trim()) sections.push(chunk);
    }
  }
  return sections;
}
