/**
 * 🔴 **マニュアルが「描ける」と言っている図の、実際の書き出し**(#528、2026-08-29)。
 *
 * ## なぜ表に抜き出したか
 *
 * `docs/manual.md` の「どんな図が描けるか」は **22 行**あるのに、
 * 焼けることを見ていた smoke は **5 種だけ**だった ──
 * ⚠ **残り 17 種は 1 つ壊れても誰も気づかない**(mermaid の版が上がった日に、
 * マニュアルが静かに嘘になる)。
 *
 * 🔑 だから **①名前をマニュアルと集合で突き合わせ**(unit・PR gate。速い)
 * **②実際に焼けるかを見る**(smoke・nightry のみ。重い)の 2 段にする。
 * ⚠ 全部を PR gate へ入れない ── smoke lane は 2026-08-28 に
 * 10 分の門へ実際にぶつかっている(プロセス指示「CI を長くしない」)。
 *
 * ⚠ **pure module**。browser API を持たない。
 */

/** 1 種。`name` は**マニュアルの 1 列目**と同じ綴りである。 */
export interface MermaidForm {
  /** ⚠ マニュアルの表の 1 列目(`graph TD` など)と**丸ごと一致**させる。 */
  readonly name: string;
  /** ```mermaid の囲みに入れる中身(1 行目が種類を決める)。 */
  readonly src: string;
}

/**
 * 🔴 **22 種**。⚠ 増減させたら `docs/manual.md` の表も同じ commit で直すこと
 * ── `tests/features/mermaid-forms-parity.test.ts` が**集合で**落とす。
 *
 * ⚠ **識別子は ASCII にしてある**ものがある(`requirementDiagram` /
 *   `architecture-beta` / `gitGraph`)── 日本語 id が通らない記法があり、
 *   fixture の書き方の問題を「製品が壊れた」と読み違えないため。
 *   🔑 見せる字(ラベル)は日本語にしてあるので、**日本語が描けること**は見ている。
 */
export const MERMAID_FORMS: readonly MermaidForm[] = [
  { name: 'graph TD', src: 'graph TD\n  受付-->台帳\n  台帳-->控え' },
  {
    name: 'classDiagram',
    src: 'classDiagram\n  class 帳簿 {\n    +記帳()\n  }\n  帳簿 <|-- 出納帳',
  },
  { name: 'sequenceDiagram', src: 'sequenceDiagram\n  受付->>台帳: 登録\n  台帳-->>受付: 控え' },
  {
    name: 'stateDiagram-v2',
    src: 'stateDiagram-v2\n  [*] --> 下書き\n  下書き --> 公開\n  公開 --> [*]',
  },
  { name: 'erDiagram', src: 'erDiagram\n  ノート ||--o{ 添付 : もつ' },
  {
    name: 'requirementDiagram',
    src:
      'requirementDiagram\n' +
      '  requirement req1 {\n' +
      '    id: 1\n' +
      '    text: hozon dekiru koto\n' +
      '    risk: high\n' +
      '    verifymethod: test\n' +
      '  }\n' +
      '  element impl {\n' +
      '    type: simulation\n' +
      '  }\n' +
      '  impl - satisfies -> req1',
  },
  {
    name: 'C4Context',
    src:
      'C4Context\n' +
      '  title システム構成\n' +
      '  Person(user, "利用者")\n' +
      '  System(pkc, "PKC")\n' +
      '  Rel(user, pkc, "使う")',
  },
  {
    name: 'gantt',
    src:
      'gantt\n' +
      '  title 日程\n' +
      '  dateFormat YYYY-MM-DD\n' +
      '  section 準備\n' +
      '  設計 :a1, 2026-08-01, 3d\n' +
      '  実装 :after a1, 5d',
  },
  { name: 'timeline', src: 'timeline\n  title 年表\n  2024 : 着手\n  2025 : 公開' },
  {
    name: 'journey',
    src: 'journey\n  title 買い物\n  section 出かける\n    財布を持つ: 5: 私\n    店へ行く: 3: 私',
  },
  { name: 'kanban', src: 'kanban\n  やること\n    [買い物]\n  おわり\n    [掃除]' },
  { name: 'mindmap', src: 'mindmap\n  root((PKC))\n    ノート\n    予定' },
  {
    name: 'gitGraph',
    src: 'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev',
  },
  { name: 'pie', src: 'pie title 内訳\n  "本文" : 60\n  "添付" : 40' },
  {
    name: 'quadrantChart',
    src:
      'quadrantChart\n' +
      '  title 優先度\n' +
      '  x-axis 低い --> 高い\n' +
      '  y-axis 小さい --> 大きい\n' +
      '  quadrant-1 すぐやる\n' +
      '  quadrant-2 計画する\n' +
      '  quadrant-3 あとで\n' +
      '  quadrant-4 任せる\n' +
      '  仕分け: [0.3, 0.6]',
  },
  {
    name: 'xychart-beta',
    src:
      'xychart-beta\n' +
      '  title "件数"\n' +
      '  x-axis ["1月", "2月", "3月"]\n' +
      '  y-axis "件" 0 --> 10\n' +
      '  bar [3, 5, 8]',
  },
  {
    name: 'radar-beta',
    src:
      'radar-beta\n' +
      '  axis a["速さ"], b["軽さ"], c["安さ"]\n' +
      '  curve x["案A"]{3, 4, 5}\n' +
      '  max 5\n' +
      '  min 0',
  },
  /**
   * 🔴 **ここだけ ASCII なのは、日本語が通らないからである**(2026-08-29 に実測)。
   *
   * ⚠ 3 通り試して分けた(1 実験 = 1 主張):
   *
   *   | 書き方 | 結果 |
   *   |---|---|
   *   | `本文,添付,5`(空行あり) | 🔴 **failed** |
   *   | `"本文","添付",5`(空行あり・引用符) | 🔴 **failed** |
   *   | `honbun,tenpu,5`(空行あり・ASCII) | ✅ **焼ける** |
   *
   * 🔑 つまり **`sankey-beta` だけ日本語のラベルを受け付けない**。
   * ⚠ マニュアルは 22 種を「**そのまま書けます**」と言っているので、
   *   **そこが嘘だった** ── 同じ commit で `docs/manual.md` に注記を入れた。
   */
  { name: 'sankey-beta', src: 'sankey-beta\n\nhonbun,tenpu,5\ntenpu,export,3' },
  { name: 'treemap-beta', src: 'treemap-beta\n"根"\n    "枝A": 30\n    "枝B": 20' },
  { name: 'block-beta', src: 'block-beta\n  columns 2\n  受付 台帳' },
  { name: 'packet-beta', src: 'packet-beta\n0-15: "送り元"\n16-31: "宛先"' },
  {
    name: 'architecture-beta',
    src:
      'architecture-beta\n' +
      '  group api(cloud)[PKC]\n' +
      '  service db(database)[台帳] in api\n' +
      '  service srv(server)[受付] in api\n' +
      '  db:L -- R:srv',
  },
];

/**
 * マニュアルの表から、1 列目の綴りを取り出す。
 * ⚠ **1 行に 2 つ書いてある行**(`graph TD` / `graph LR`)は**最初の 1 つ**を採る
 *   ── 表の意図が「代表の綴り」だからである。
 * ⚠ 節を `### どんな図が描けるか` から**次の見出しまで**で切る ── 切らないと
 *   本文の別の表(記法一覧)に満たされる(CLAUDE.md §1「範囲が広すぎる」)。
 */
export function manualDiagramNames(manual: string): string[] {
  const at = manual.indexOf('### どんな図が描けるか');
  if (at < 0) return [];
  const rest = manual.slice(at + 1);
  const end = rest.indexOf('\n## ');
  const nextH3 = rest.indexOf('\n### ');
  const cut = [end, nextH3].filter((n) => n >= 0);
  const seg = cut.length > 0 ? rest.slice(0, Math.min(...cut)) : rest;
  const out: string[] = [];
  for (const line of seg.split('\n')) {
    const m = /^\|\s*`([^`]+)`/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}
