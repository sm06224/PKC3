/**
 * 🔴 **使っている OSS の表記・開発者名・ソースへの導線**(#948。user 裁定 2026-09-15)。
 *
 * ## なぜここに置くか
 *
 * ⚠ **pure module**。node_modules を読んで一覧を焼くのは
 * `build/oss-notices-plugin.ts`(build 側の仕事)── ここは**焼かれた後のデータ**の
 * 型と、それを画面の字へ組む純粋関数だけを持つ(`core ← features ← adapter` を
 * 保つため、browser API も node の fs も使わない)。
 *
 * ## 🔴 裁定済みの値(変えない)
 *
 * | | 値 |
 * |---|---|
 * | 著作権者 | `sm06224`(実名は出さない) |
 * | AI との共作の併記 | 「Claude Code(Anthropic)と一緒に作っています」 |
 * | GitHub への導線 | `https://github.com/sm06224/PKC3` |
 *
 * ## ⚠ ここで数えない物(docstring に明記。user 裁定どおり「別に入る物です」)
 *
 * **Office 表示のための LibreOffice 一式**(別 repo で焼く)と、
 * **DuckDB を動かす追加の部品**(duckdb-assets-plugin が配る wasm / worker /
 * 拡張の実体)は、この一覧に含めない。⚠ **`@duckdb/duckdb-wasm` という npm package
 * 自体は** `package.json` の `dependencies` に在るので**一覧には載る**
 * (その package.json の `license` を素直に読むだけ)── 除外しているのは
 * 「DuckDB や LibreOffice が *内部で* 束ねている C++ 側の依存(re2 / parquet / ICU 等)
 * まで洗い出す」という、この回ではやらない全数調査のほうである。
 *
 * ## 🔴 逆に、devDependency なのに数える物が 1 つある(#1054 段①)
 *
 * `@phosphor-icons/web`(図案の書体 `pkc-symbols.woff2` の焼き元)は実行時に
 * import されないので `dependencies` の自動収集には出てこないが、glyph データの
 * 部分集合が配布物に入るので**表記義務は生きている**。`build/oss-notices-plugin.ts`
 * の `VENDORED_FONT_SOURCES` が名指しで足す(`devDependencies` 全体は数えない ──
 * eslint / vite のような、出力に 1 bytes も残らない道具まで混ざるのを防ぐため)。
 *
 * 🔴 **`OSS_SCOPE_NOTE` はいまも正しい**(#682 段④b で読み直した)── 拡張 3 つ
 * (`json` / `parquet` / `sqlite_scanner`)は `vendor/duckdb-extensions/` に
 * **repo へ置いた**が、配り方は wasm 本体と同じ「**使うときにこの端末へ入る**」で、
 * precache にも載せていない。⚠ だから断り書きの字は変えない
 * (変えると、この一覧の**範囲そのもの**が変わったように読める)。
 * 🔑 出どころと sha256 と種別(**MIT License** ── DuckDB Foundation / DuckDB Labs)は
 * `vendor/duckdb-extensions/README.md` に在る。
 */

/**
 * 1 依存ぶんの表記。⚠ **`build/oss-notices-plugin.ts` が焼く形と揃える**
 * (`src/virtual-modules.d.ts` の `virtual:pkc-oss-notices` はこの型を指す)。
 */
export interface OssNotice {
  /** `package.json` の `dependencies` に書かれた名前(scope 込み)。 */
  readonly name: string;
  /** SPDX の種別(`package.json` の `license`)。 */
  readonly license: string;
  /**
   * 配布物に同梱された全文。⚠ **無ければ `null`**(標準のひな型を当てはめて
   * 捏造しない ── 事実だけを出す)。
   */
  readonly text: string | null;
}

/** 著作権者。⚠ 実名は出さない(user 裁定)。 */
export const OSS_DEVELOPER = 'sm06224';

/** AI との共作の併記。⚠ 文面そのものが裁定済み。 */
export const OSS_AI_COAUTHOR = 'Claude Code(Anthropic)と一緒に作っています';

/** GitHub への導線。⚠ URL そのものが裁定済み。 */
export const OSS_SOURCE_URL = 'https://github.com/sm06224/PKC3';

/** 「開発: …」の 1 行。 */
export function ossDeveloperLine(): string {
  return `開発: ${OSS_DEVELOPER} ── ${OSS_AI_COAUTHOR}`;
}

/** 一覧の見出しに出す、件数つきの字。⚠ **切るのはここ 1 か所**(面ごとに数えない)。 */
export function ossNoticesLabel(list: readonly OssNotice[]): string {
  return `使っているオープンソース(${String(list.length)} 件)`;
}

/**
 * 全文が同梱されていないときの断り書き。
 * ⚠ **法律の断定を書かない** ── 「このライセンスなら〜してよい」のような解釈は
 *   書かず、「全文が無い」「種別は何か」という事実だけを言う。
 */
export function ossNoticesMissingText(license: string): string {
  return `この配布物には全文(LICENSE)が同梱されていません。種別は「${license}」です。`;
}

/**
 * 🔴 この一覧が数えていない物への断り書き(画面とマニュアルの両方に出す)。
 * ⚠ **1 か所で持つ**(CLAUDE.md §7)── 画面側の文言と、マニュアルの説明文が
 *   別々に古びるのを防ぐ。
 */
export const OSS_SCOPE_NOTE =
  'Office 表示のための LibreOffice 一式と、DuckDB を動かす追加の部品は、' +
  'ここには数えていません。使うときにこの端末へ直接入る、別の配布だからです。';
