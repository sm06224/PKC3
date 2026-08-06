/**
 * frontmatter から document globals(writing / direction / align / layout /
 * heading-number)を抽出する helper(PKC2 reform-2026-05 PR-2A / PR-2N / 領域 8 の移植)。
 *
 * 各 key の意味:
 *   - writing: `horizontal | vertical`。CSS `writing-mode` を指定(vertical は
 *     `vertical-rl` 既定、direction=ltr で `vertical-lr`)
 *   - direction: `ltr | rtl`。HTML `dir` 属性 + CSS `direction`
 *   - align: `left | right | center | top | bottom`。writing と直交
 *     (horizontal は left/right/center、vertical は top/bottom/center のみ)
 *   - layout: 用紙サイズ + 段組(`a4-2col` 等)。print / 段組 CSS が消費
 *   - heading-number: 見出しアウトライン番号(renderMarkdown の opts.headingNumber へ)
 *
 * 不正値 / 不正組み合わせは silent fail ではなく構造化 warning + default 復帰。
 *
 * PKC3 変更点:
 *   - `list-number`(editor の順序リスト採番)は未移植 ── editor 採番機能の
 *     導入時に一緒に持ち込む(P3-5 時点で読む者がいない definition を置かない)
 *   - `applyDocumentGlobals(el, globals)` を追加 ── data-pkc-* と **`dir` 属性**を
 *     1 箇所で付ける。PKC2 では dir 付与が caller 責務で 4 surface に重複していた
 *     (rendered-viewer / entry-window で付け漏れが実際に起きた教訓の畳み込み)
 *
 * ⚠ writing / layout の CSS 消費(writing-mode / 段組)は PKC3 未導入 ──
 * スタイル導入(P3-7 予定)時に PKC2 base.css の該当 2 ブロックを移す。
 * 属性契約はここで先に固定する。
 */
import { parseFrontmatter } from './frontmatter';

export type Writing = 'horizontal' | 'vertical';
export type Direction = 'ltr' | 'rtl';
export type Align = 'left' | 'right' | 'center' | 'top' | 'bottom';
export type Layout =
  | 'a4-1col' | 'a4-2col' | 'a4-3col'
  | 'b5-1col' | 'b5-2col'
  | 'letter-1col' | 'letter-2col'
  | 'legal-1col' | 'legal-2col';

export interface DocumentGlobals {
  writing?: Writing;
  direction?: Direction;
  align?: Align;
  layout?: Layout;
  /** 不正値 / 不正組み合わせ検出時の構造化 warning(silent fail 回避)。 */
  warnings: GlobalWarning[];
}

export interface GlobalWarning {
  kind: 'invalid_value' | 'invalid_combo';
  key: string;
  detail: string;
}

const VALID_WRITING: ReadonlySet<Writing> = new Set(['horizontal', 'vertical'] as const);
const VALID_DIRECTION: ReadonlySet<Direction> = new Set(['ltr', 'rtl'] as const);
const VALID_ALIGN: ReadonlySet<Align> = new Set(['left', 'right', 'center', 'top', 'bottom'] as const);
const VALID_LAYOUT: ReadonlySet<Layout> = new Set([
  'a4-1col', 'a4-2col', 'a4-3col',
  'b5-1col', 'b5-2col',
  'letter-1col', 'letter-2col',
  'legal-1col', 'legal-2col',
] as const);

const HORIZONTAL_ALIGNS: ReadonlySet<Align> = new Set(['left', 'right', 'center'] as const);
const VERTICAL_ALIGNS: ReadonlySet<Align> = new Set(['top', 'bottom', 'center'] as const);

/** frontmatter から document globals を抽出。不在 / 全省略なら全 undefined。 */
export function extractDocumentGlobals(body: string): DocumentGlobals {
  const result: DocumentGlobals = { warnings: [] };
  if (!body) return result;
  const fm = parseFrontmatter(body);
  if (!fm.found) return result;

  const writingRaw = fm.meta['writing'];
  if (typeof writingRaw === 'string') {
    if (VALID_WRITING.has(writingRaw as Writing)) {
      result.writing = writingRaw as Writing;
    } else {
      result.warnings.push({
        kind: 'invalid_value',
        key: 'writing',
        detail: `'${writingRaw}' は writing として無効。'horizontal' or 'vertical' のみ。`,
      });
    }
  }

  const directionRaw = fm.meta['direction'];
  if (typeof directionRaw === 'string') {
    if (VALID_DIRECTION.has(directionRaw as Direction)) {
      result.direction = directionRaw as Direction;
    } else {
      result.warnings.push({
        kind: 'invalid_value',
        key: 'direction',
        detail: `'${directionRaw}' は direction として無効。'ltr' or 'rtl' のみ。`,
      });
    }
  }

  const layoutRaw = fm.meta['layout'];
  if (typeof layoutRaw === 'string') {
    if (VALID_LAYOUT.has(layoutRaw as Layout)) {
      result.layout = layoutRaw as Layout;
    } else {
      result.warnings.push({
        kind: 'invalid_value',
        key: 'layout',
        detail: `'${layoutRaw}' は layout として無効。'a4-1col' / 'a4-2col' / 'a4-3col' / 'b5-1col' / 'b5-2col' / 'letter-1col' / 'letter-2col' / 'legal-1col' / 'legal-2col' のみ。`,
      });
    }
  }

  const alignRaw = fm.meta['align'];
  if (typeof alignRaw === 'string') {
    if (!VALID_ALIGN.has(alignRaw as Align)) {
      result.warnings.push({
        kind: 'invalid_value',
        key: 'align',
        detail: `'${alignRaw}' は align として無効。'left' / 'right' / 'center' / 'top' / 'bottom' のみ。`,
      });
    } else {
      const align = alignRaw as Align;
      const writing = result.writing ?? 'horizontal';
      const validForWriting = writing === 'horizontal' ? HORIZONTAL_ALIGNS : VERTICAL_ALIGNS;
      if (!validForWriting.has(align)) {
        result.warnings.push({
          kind: 'invalid_combo',
          key: 'align',
          detail: `writing='${writing}' で align='${align}' は不正(horizontal は left/right/center、vertical は top/bottom/center のみ)。default 復帰。`,
        });
      } else {
        result.align = align;
      }
    }
  }

  return result;
}

/** DocumentGlobals を `data-pkc-*` attribute の record に変換(dir は含まない)。 */
export function globalsToDataAttrs(globals: DocumentGlobals): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (globals.writing) attrs['data-pkc-writing'] = globals.writing;
  if (globals.direction) attrs['data-pkc-direction'] = globals.direction;
  if (globals.align) attrs['data-pkc-doc-align'] = globals.align;
  if (globals.layout) attrs['data-pkc-layout'] = globals.layout;
  return attrs;
}

/**
 * `applyDocumentGlobals` が触る属性の全部(**消す側の正本**)。
 * ⚠ ここに足したら `globalsToDataAttrs` にも足す ── 逆も同じ。
 * `tests/features/document-globals.test.ts` が「出せる key は全部消せる」を pin する。
 */
export const DOCUMENT_GLOBAL_ATTRS: readonly string[] = [
  'data-pkc-writing',
  'data-pkc-direction',
  'data-pkc-doc-align',
  'data-pkc-layout',
  'dir',
];

/**
 * rendered root 要素へ globals を適用する(data-pkc-* + `dir` 属性を 1 箇所で)。
 * 別 document の surface(Viewer popup 等、P3-8)もこれを呼ぶこと ── 個別実装に
 * よる付け漏れを構造的に防ぐ。
 *
 * 🔴 **先に全部消してから当てる**(2026-08-06)。器は使い回されるので、
 * 付けるだけだと**前のノートの書字方向が残る** ── `align: right` のノートを見た後に
 * 宣言の無いノートを開くと、`data-pkc-doc-align="right"` / `dir="rtl"` /
 * `data-pkc-writing="vertical"` が生き残り、**前の文書の見え方で次の文書が描かれる**。
 * 直す前は `setAttribute` だけで、`removeAttribute` がどこにも無かった
 * (読む面の器は `bodyKind === 'md'` の間ずっと同じ要素である)。
 */
export function applyDocumentGlobals(el: HTMLElement, globals: DocumentGlobals): void {
  for (const k of DOCUMENT_GLOBAL_ATTRS) el.removeAttribute(k);
  for (const [k, v] of Object.entries(globalsToDataAttrs(globals))) {
    el.setAttribute(k, v);
  }
  if (globals.direction) el.setAttribute('dir', globals.direction);
}

/**
 * frontmatter `heading-number` から見出しアウトライン番号の設定を抽出(opt-in)。
 *   heading-number: true / on → { start: 1 }、数値 n≥1 → { start: n }、他 → null。
 * caller は全文 body(frontmatter 込み)を渡し、戻り値を `renderMarkdown` の
 * `opts.headingNumber` へ渡す(前処理は text レベル・LineMap 不変)。
 */
export function extractHeadingNumberConfig(body: string): { start: number } | null {
  if (!body) return null;
  const raw = parseFrontmatter(body).meta['heading-number'];
  if (raw === true || raw === 'true' || raw === 'on') return { start: 1 };
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    return { start: Math.floor(raw) };
  }
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 1) return { start: Math.floor(n) };
  }
  return null;
}
