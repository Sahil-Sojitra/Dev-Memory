import type { SearchCandidate, SearchResult, SearchInput, SearchField, ScorePart } from "../domain/search-knowledge.ts";
import { SEARCH_FIELDS, normalizeSearch, searchTokens } from "../domain/search-knowledge.ts";
import type { KnowledgeBody } from "../domain/knowledge-entry.ts";

export const SEARCH_WEIGHTS: Readonly<Record<SearchField, number>> = Object.freeze({
  title: 80, context: 30, files: 35, sourceUrl: 10, tags: 25, type: 15, verification: 10, project: 5, subproject: 5, body: 45,
});
export const SEARCH_SNIPPET_CHARACTERS = 240;
function phraseIn(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length < 2) return false;
  return haystack.some((_token, index) => needle.every((token, offset) => haystack[index + offset] === token));
}
function snippet(text: string, query: string): string {
  const display = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const folded = display.toLowerCase();
  const wanted = new Set(searchTokens(query));
  let position = 0;
  // Use the same Unicode letter/number/underscore tokens as searchTokens.
  for (const token of folded.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (wanted.has(token[0])) { position = token.index; break; }
  }
  // Lowercasing can expand a code point (for example, capital dotted I).
  // Translate the folded offset back to the case-preserving display string.
  let displayPosition = 0, foldedPosition = 0;
  for (const point of display) {
    if (foldedPosition >= position) break;
    foldedPosition += point.toLowerCase().length; displayPosition += point.length;
  }
  let start = Math.max(0, displayPosition - 60);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(display[start]!)) start--;
  let end = Math.min(display.length, start + SEARCH_SNIPPET_CHARACTERS - 6);
  if (end < display.length && /[\uD800-\uDBFF]/.test(display[end - 1]!)) end--;
  return (start ? "..." : "") + display.slice(start, end) + (end < display.length ? "..." : "");
}
export function rankCandidate(candidate: SearchCandidate, input: SearchInput, body?: KnowledgeBody): SearchResult {
  const queryTokens = searchTokens(input.query);
  const unique = [...new Set(queryTokens)];
  const values: Record<SearchField, string> = {
    title: candidate.name, context: candidate.context ?? "", files: candidate.files ?? "", sourceUrl: candidate.sourceUrl ?? "",
    tags: candidate.tags.join(" "), type: candidate.type ?? "", verification: candidate.verification ?? "",
    project: candidate.projectIds.join(" "), subproject: candidate.subprojectIds.join(" "), body: body?.markdown ?? "",
  };
  const breakdown: ScorePart[] = [];
  let bestText = "";
  let bestPoints = 0;
  for (const field of SEARCH_FIELDS) {
    if (field === "body" && !body) continue;
    const tokens = searchTokens(values[field]); const tokenSet = new Set(tokens);
    const hits = unique.filter((token) => tokenSet.has(token)).length;
    if (!hits) continue;
    const phraseMatch = phraseIn(tokens, queryTokens);
    const points = SEARCH_WEIGHTS[field] * (hits + (phraseMatch ? 1 : 0)) + (field === "title" && normalizeSearch(candidate.name) === input.query ? 1000 : 0);
    breakdown.push(Object.freeze({ field, tokenMatches: hits, phraseMatch, points }));
    if (points > bestPoints) { bestPoints = points; bestText = values[field]; }
  }
  return Object.freeze({ id: candidate.id, title: candidate.name, url: candidate.url,
    ...(candidate.type ? { type: candidate.type } : {}), ...(candidate.verification ? { verification: candidate.verification } : {}),
    projectIds: candidate.projectIds, subprojectIds: candidate.subprojectIds, relationsTruncated: candidate.relationsTruncated,
    tags: candidate.tags, lastUpdated: candidate.lastUpdated, snippet: snippet(bestText, input.query),
    matchedIn: Object.freeze(breakdown.map((item) => item.field)), score: breakdown.reduce((sum, item) => sum + item.points, 0) + Math.max(0, breakdown.length - 1) * 10,
    scoreBreakdown: Object.freeze(breakdown), bodyScanned: body !== undefined, bodyTruncated: body?.truncated ?? false, bodyTruncationReasons: body?.reasons ?? [],
  });
}
export function compareSearchResults(a: SearchResult, b: SearchResult): number {
  return b.score - a.score || Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
