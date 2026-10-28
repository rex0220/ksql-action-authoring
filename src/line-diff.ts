/**
 * 行の差分（LCS）。**印刷屋のオーサリング tools（tools/src/normalize/line-diff.ts。MIT・同じ作者）からの写し**（そのまま）。
 * kact では SQL と計算式の比較に使う。大きすぎるときは全体の置き換えとして返す。
 */

export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > MAX_CELLS) {
    return [...A.map((t) => ({ kind: "-" as const, text: t })), ...B.map((t) => ({ kind: "+" as const, text: t }))];
  }
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: " ", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "-", text: A[i] });
      i++;
    } else {
      out.push({ kind: "+", text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "-", text: A[i++] });
  while (j < m) out.push({ kind: "+", text: B[j++] });
  return out;
}

/** 変わった行と前後 context 行だけにする */
export function formatDiff(lines: DiffLine[], context = 2): string {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipping = false;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      if (!skipping) out.push("  …");
      skipping = true;
      return;
    }
    skipping = false;
    out.push(`${l.kind} ${l.text}`);
  });
  return out.join("\n");
}
