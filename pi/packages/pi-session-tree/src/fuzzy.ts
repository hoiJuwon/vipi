/**
 * fzf-lite: subsequence matching with scoring.
 * Score: +1 per matched char, +4 per consecutive run continuation,
 * +6 if the match starts at index 0. Case-insensitive. null = no match.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      score += 1;
      if (ci === prevMatch + 1) score += 4;
      if (qi === 0 && ci === 0) score += 6;
      prevMatch = ci;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string): T[] {
  if (query.length === 0) return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, key(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
