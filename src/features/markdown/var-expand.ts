/**
 * `{{vars.x}}` の展開と、それが使う fence の追跡(葉の module)。
 *
 * 🔑 描画(markdown-render)・目次(markdown-toc)・章の追記先(append-target)が
 *   **同じ関数**で見出しの字を作る ── 見出しの id は展開後の字から作られるので、
 *   展開の規則が 1 つでも違うと、目次を押しても飛ばない / 埋め込みが「見出しが見つかりません」になる(#1087)。
 *   markdown-render は markdown-toc を import しているので、共有する実体はここ(どちらも import しない)に置く。
 */
import { VAR_NAME_SOURCE } from './frontmatter';
import { splitLines } from './source-blocks';
import { fenceStep, advanceIndent, INDENT_START, LIST_LEAD, type IndentState } from './list-renumber';

export interface FenceState {
  inFence: boolean;
  marker: string;  // '```' or '~~~'(空 = 閉。`inFence` かつ空 = 字下げのコード)
  ind?: IndentState;  // 字下げのコードの追跡(無ければ文書の頭)
}

export function fenceTransition(line: string, state: FenceState): { state: FenceState; isBoundary: boolean } {
  // 🔑 開閉の規則の正本は `advanceFence`(記号の種類 + 長さ。#1087)。
  //   かつては種類しか見ず、4 つの ``` の中の ``` で閉じたことになり、中の `%%%` / `:::` が生きた。
  //   ⚠ 引用・リストの項目の中の fence(`> ````  / `- ````)も同じ正本が見る(M9)。
  const inRealFence = state.inFence && state.marker !== '';
  const cur = inRealFence ? state.marker : '';
  const st = fenceStep(cur, line);
  const next = st.next;
  const ind = state.ind ?? INDENT_START;
  // 🔴 入れ物(引用・リストの項目)が終わって fence が打ち切られた行は `inside` が偽 ── 外の行として読む
  if (inRealFence && st.inside && next === cur) return { state, isBoundary: false };
  if (st.inside) {
    const after: IndentState = { blank: false, list: ind.list || LIST_LEAD.test(line), code: false };
    return next === ''
      ? { state: { inFence: false, marker: '', ind: after }, isBoundary: true }
      : { state: { inFence: true, marker: next, ind: after }, isBoundary: true };
  }
  // fence の外 ── 字下げのコード(4 SP。空行の後で、リストの中ではないもの)も素通しの対象(M9)
  const r = advanceIndent(ind, line);
  return { state: { inFence: r.code, marker: '', ind: r.state }, isBoundary: false };
}

// ── 変数の展開 ──

export const VAR_OPEN = '\u{E140}';
export const VAR_SEP = '\u{E141}';
// 名前の字の範囲は frontmatter の `VAR_NAME_SOURCE` 1 本(定義 `vars:` と展開で食い違わせない。日本語の名前も通る)
// 🔑 参照(`VAR_REF_RE`)が `{{ vars.x }}` と空白を許すので、escape も同じ幅で許す(#1087 N8)
const VAR_ESCAPED_RE = new RegExp(`\\\\\\{\\{(\\s*vars\\.${VAR_NAME_SOURCE}\\s*)\\}\\}`, 'gu');
const VAR_REF_RE = new RegExp(`\\{\\{\\s*vars\\.(${VAR_NAME_SOURCE})\\s*\\}\\}`, 'gu');
const VAR_ESCAPE_BACK_RE = new RegExp(`\\u{E142}(\\s*vars\\.${VAR_NAME_SOURCE}\\s*)\\u{E143}`, 'gu');

export function expandVarsInText(source: string, vars: Record<string, string>): string {
  if (!source) return source;
  /**
   * 🔴 **本文に目印が無いなら段ごと素通りする**(2026-08-07)。出力は 1 バイトも
   * 変わらない ── この段は目印が 1 つも無ければ全行をそのまま流すだけである。
   * ⚠ 目印は**広い側**に取る(狭すぎるとその記法が黙って効かなくなる)。
   */
  if (!source.includes('{{')) return source;
  const lines = splitLines(source);
  let fence: FenceState = { inFence: false, marker: '' };
  return lines.map((line) => {
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) return line;
    // escape(`\{{vars.x}}`)優先。先に escape を sentinel(U+E142)で隠して
    // 通常の置換を行い、最後に元に戻す。
    let out = line.replace(VAR_ESCAPED_RE, '\u{E142}$1\u{E143}');
    // 🔴 表の行(`|` で始まる行)に入れる値は、`|` を `\|` にし改行を空白にする ── 値の `|` や改行で列・行が割れない
    const inTableRow = /^\s*\|/.test(line);
    out = out.replace(VAR_REF_RE, (_match, key: string) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        // 🔴 値の改行は空白 1 つにする(台帳 #1852 束 R1、依頼 269 A)── 行が増えると、下のチェック・表の行番号が 1 つずれて
        //   別の項目に印が付く。変数は語句を差し込む物で、段落を差し込む物ではない
        let v = vars[key]!.replace(/\r\n|\r|\n/g, ' ');
        if (inTableRow) v = v.replace(/\|/g, '\\|');
        // escape sentinel char が値内にあれば剥がす(衝突対策)
        return v.replace(new RegExp(`[${VAR_OPEN}${VAR_SEP}]`, 'g'), '');
      }
      return `${VAR_OPEN}${key}${VAR_SEP}`;
    });
    out = out.replace(VAR_ESCAPE_BACK_RE, (_m, ref: string) => `{{${ref}}}`);
    return out;
  }).join('\n');
}


/**
 * 🔴 **定義の在る変数だけを展開し、それ以外は 1 字も変えない**(台帳 #1852 束 R1、依頼 268 A)。
 *
 * 別のノートの章を埋め込むとき、章の中の `{{vars.案件}}` は**元のノートの前書きの値**で出す
 * (元のノートで読んだときと同じ字になる)。埋め込んだ側には前書きが無いので、元のノートの側で展開してから渡す。
 * ⚠ `expandVarsInText` と違い、**未定義の名前と `\{{vars.x}}`(字のまま書く印)は触らない**
 *   (未定義の印の sentinel は、描画の入り口で潰されるため、そのまま渡せない)。
 * ⚠ 値の改行は空白 1 つにする(`expandVarsInText` と同じ。行数を変えない)。
 */
export function expandDefinedVars(source: string, vars: Record<string, string>): string {
  if (!source || !source.includes('{{')) return source;
  const lines = splitLines(source);
  let fence: FenceState = { inFence: false, marker: '' };
  return lines.map((line) => {
    const t = fenceTransition(line, fence);
    fence = t.state;
    if (fence.inFence || t.isBoundary) return line;
    // 字のまま書く `\{{vars.x}}` は先に隠す(`expandVarsInText` と同じ)
    let out = line.replace(VAR_ESCAPED_RE, '\u{E142}$1\u{E143}');
    const inTableRow = /^\s*\|/.test(line);
    out = out.replace(VAR_REF_RE, (match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
      let v = vars[key]!.replace(/\r\n|\r|\n/g, ' ');
      if (inTableRow) v = v.replace(/\|/g, '\\|');
      return v.replace(new RegExp(`[${VAR_OPEN}${VAR_SEP}]`, 'g'), '');
    });
    // 隠した物は、逃がしの `\` ごと元に戻す
    return out.replace(VAR_ESCAPE_BACK_RE, (_m, ref: string) => `\\{{${ref}}}`);
  }).join('\n');
}

/**
 * 展開で残した「未定義」の印(U+E140 key U+E141)を、見える字 `{{vars.key}}` へ戻す。
 * 🔑 目次の表示用 ── id は印のまま作る(描画と同じ)が、画面に出す字は印を含めない。
 */
export function restoreUndefinedVars(text: string): string {
  if (!text.includes(VAR_OPEN)) return text;
  return text.replace(
    new RegExp(`${VAR_OPEN}(${VAR_NAME_SOURCE})${VAR_SEP}`, 'gu'),
    (_m, key: string) => `{{vars.${key}}}`,
  );
}
