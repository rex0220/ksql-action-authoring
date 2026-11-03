/**
 * 本体（ksql-action）の `src/desktop/formula-run.ts` が使う `kintone` グローバルの型。
 *
 * tools は `import type { KsqlActionAuthoringApi } from "ksql-action/src/authoring/api.ts"` で本体の型を見る。
 * authoring API が版 4 で `formula-run.ts` の評価の関数を公開したので、その**型の解決のためだけ**に要る。
 * **tools は `kintone` を呼ばない**（kintone への通信は `src/kintone-rest.ts` の GET だけ。
 * 評価に使う `evalFormula` などは `pp` と `record` を引数で受けるので、この口は通らない）。
 */
declare const kintone: {
  api: ((url: string, method: string, params: unknown) => Promise<unknown>) & {
    url(path: string, detectGuestSpace?: boolean): string;
  };
};
