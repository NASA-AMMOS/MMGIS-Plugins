function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

function scoreCandidate(query, candidate) {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q) return 0;
  if (q === c) return 1;
  if (c && c.includes(q)) {
    return Math.max(0.8, q.length / Math.max(c.length, 1));
  }
  if (q && q.includes(c)) {
    return Math.max(0.7, c.length / Math.max(q.length, 1));
  }
  const dist = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length, 1);
  return Math.max(0, 1 - dist / maxLen);
}

module.exports = {
  normalizeName,
  scoreCandidate,
};
