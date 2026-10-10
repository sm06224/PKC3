/**
 * 🔴 **タグに色を付ける**(#1457。Gemini 経由の裁定 2026-10-10)。
 *
 * 求められていたこと(解釈):タグごとに **user 自身が色を 1 つ決められる**ようにする。
 * 色を決めたタグだけが色つきの札で出て、決めていないタグはいままでどおりの灰色の札のまま。
 * **こちらから意味を与えた色は無い**(信号機の既定などは作らない)。付けた色は外せる。
 *
 * ## 🔑 「地は無彩色、色は情報にだけ使う」(user 指示 2026-08-03)との関係
 *
 * 既定は 1 色も増えない ── 色が出るのは **user が自分で決めたタグだけ**で、その色は
 * 「このタグはこの種類だ」という user 自身の情報である。`tag-badge.ts` の
 * 「色は使わない」は**既定の見え方**の話で、この機能はそれを覆さない(user が選んだ分だけ足す)。
 *
 * ## どこに持つか(正本)
 *
 * タグは `tags:` の文字列で、独立した record を持たない(`tag-system-design-2026-08.md` §2)。
 * 色を各ノートの本文に書くと、同じタグが場所によって別の色になる。だから
 * **コレクション(器)に 1 組だけ持つ**: sqlite の `settings` 表の 1 行 1 タグ
 * (`scope = 'tag-color:<cid>'`)。表を足さないので版(`DB_SCHEMA_VERSION`)は上げない。
 * バックアップ(`.pkc3-*.zip`)の `container.json` に `tagColors` として入れ、取り込みで戻す。
 * ⚠ 端末の好み(localStorage)には置かない ── 別の端末へ持って行けない。
 *
 * ## 見え方(`tag-badge.ts` の 3 つの見せ方に対して)
 *
 * | 見せ方 | 色の当て方 |
 * |---|---|
 * | バッジ(既定) | 下地を選んだ色にし、字は黒か白を**自動で**選ぶ(`tagInkFor`) |
 * | 枠だけのバッジ | 枠の線だけを選んだ色にする(字はテーマの色のまま ── 淡い色でも読める) |
 * | 文字のまま | **色は付けない**(「いままでと同じ」と名乗っている見せ方なので) |
 *
 * 🔑 **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */
import { normalizeTag } from '@features/flavor/tags';

/** 色を持てるタグの数の上限。⚠ 上限が無いと、取り込んだ壊れたバックアップが表を埋める。 */
export const MAX_TAG_COLORS = 500;

export interface TagColorEntry {
  /** 画面に出す綴り(user が付けたとおり)。 */
  readonly tag: string;
  /** `#rrggbb`(小文字)。 */
  readonly color: string;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * 色の綴りを検める。受けるのは **`#rrggbb` だけ**(付箋・線の色と同じ規則)。
 * @returns 小文字にそろえた `#rrggbb`。読めなければ `null`(3 桁・8 桁・名前・前後の空白は受けない)
 */
export function normalizeTagColor(raw: unknown): string | null {
  return typeof raw === 'string' && HEX6.test(raw) ? raw.toLowerCase() : null;
}

/** 突き合わせの鍵(`sameTag` と同じ ── 大小は無視する)。空になるタグは `null`。 */
export function tagColorKey(tag: string): string | null {
  const t = normalizeTag(tag);
  return t === '' ? null : t.toLowerCase();
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG の相対輝度(0〜1)。`#rrggbb` を渡す。 */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG のコントラスト比(1〜21)。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 色つきの札の上に載せる字の色(黒 / 白)。
 *
 * 🔑 **黒と白のうち、コントラスト比が高いほう**を選ぶ。どんな下地でも、黒と白の
 * 良いほうは 4.58 以上になる(境目の輝度 ≈ 0.179 で両者が等しく 4.58)ので、
 * 「4.5 以上」は全 1677 万色で満たせる(`tests/features/tag-color.test.ts` が総当たりで見る)。
 * テーマ(明るい / 暗い)に関係なく、札は自分の下地と字を**セットで**持つ。
 */
export function tagInkFor(color: string): '#000000' | '#ffffff' {
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#ffffff') ? '#000000' : '#ffffff';
}

/** そのタグの色(無ければ `null`)。 */
export function tagColorOf(list: readonly TagColorEntry[], tag: string): string | null {
  const key = tagColorKey(tag);
  if (key === null) return null;
  return list.find((e) => tagColorKey(e.tag) === key)?.color ?? null;
}

export type TagColorChange =
  | { readonly ok: true; readonly list: TagColorEntry[] }
  | { readonly ok: false; readonly reason: 'invalid-tag' | 'invalid-color' | 'limit' };

/**
 * 色を付ける / 変える(`color` が文字列)・**外す**(`null`)。
 *
 * 🔑 **付けられるなら外せる**(片道の操作を作らない ── CLAUDE.md 2026-08-23)。外すと、
 * そのタグは「色を決めていないタグ」に戻る(灰色の札)。⚠ 色の綴りが `#rrggbb` で
 * なければ**付けずに断る**(黙って別の色にしない)。
 * 同じタグ(大小違い)の色は**置き換える**(2 つ並べない)。
 */
export function withTagColor(
  list: readonly TagColorEntry[],
  tag: string,
  color: string | null,
): TagColorChange {
  const key = tagColorKey(tag);
  if (key === null) return { ok: false, reason: 'invalid-tag' };
  const rest = list.filter((e) => tagColorKey(e.tag) !== key);
  if (color === null) return { ok: true, list: rest };
  const c = normalizeTagColor(color);
  if (c === null) return { ok: false, reason: 'invalid-color' };
  if (rest.length >= MAX_TAG_COLORS) return { ok: false, reason: 'limit' };
  return { ok: true, list: [...rest, { tag: normalizeTag(tag), color: c }] };
}

/**
 * バックアップ(JSON)から読んだ値を検めて、使える分だけ返す。
 * ⚠ 配列でなければ空。形の違う要素・`#rrggbb` でない色・重複・上限超えは**落として数える**
 * (黙って捨てない ── `dropped` を呼び側が言う)。
 */
export function parseTagColorList(raw: unknown): { list: TagColorEntry[]; dropped: number } {
  if (!Array.isArray(raw)) return { list: [], dropped: 0 };
  let list: TagColorEntry[] = [];
  let dropped = 0;
  for (const r of raw) {
    const tag = (r as { tag?: unknown } | null)?.tag;
    const color = (r as { color?: unknown } | null)?.color;
    if (typeof tag !== 'string' || typeof color !== 'string') {
      dropped++;
      continue;
    }
    const next = withTagColor(list, tag, color);
    if (!next.ok) {
      dropped++;
      continue;
    }
    list = next.list;
  }
  return { list, dropped };
}

/**
 * 取り込む色を、いまの色に**足りない分だけ**足す(いま付けている色は動かさない)。
 * @returns 足した分(`added`)/ いま付いていたので見送った数(`kept`)/ 上限(`MAX_TAG_COLORS`)で戻せなかった数(`overLimit`)
 */
export function mergeMissingTagColors(
  current: readonly TagColorEntry[],
  incoming: readonly TagColorEntry[],
): { list: TagColorEntry[]; added: TagColorEntry[]; kept: number; overLimit: number } {
  let list = [...current];
  const added: TagColorEntry[] = [];
  let kept = 0;
  let overLimit = 0;
  for (const e of incoming) {
    if (tagColorOf(list, e.tag) !== null) {
      kept++;
      continue;
    }
    const next = withTagColor(list, e.tag, e.color);
    if (next.ok) {
      list = next.list;
      added.push({ tag: normalizeTag(e.tag), color: e.color });
    } else if (next.reason === 'limit') {
      overLimit++;
    }
  }
  return { list, added, kept, overLimit };
}

/**
 * CSS の属性値(`"…"`)に入れるための escape。
 * ⚠ 引用符・逆斜線のほか、**制御文字(U+0000〜U+001F・U+007F)を全部**`\XX `(16 進 + 空白)で書く
 * (`\f` や NUL を生で書くと、改行扱いで文字列が閉じたり、読み手が捨てたりして規則の外へ出る)。
 */
function cssString(s: string): string {
  // eslint-disable-next-line no-control-regex -- 制御文字を拾うのが目的
  return s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) =>
    c === '\\' || c === '"' ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `,
  );
}

/**
 * 色の一覧から、画面に当てる CSS を 1 本組む。
 *
 * 🔴 **鍵で引く**: バッジが持つ `data-pkc-tag-key`(= `tagColorKey(名前)`)と**完全一致**で当てる。
 * 以前は `data-pkc-tag="…" i` だったが、CSS の `i` は ASCII だけの大小無視なので、
 * 全角 Ａ/ａ・Ä/ä が `sameTag`(Unicode の `toLowerCase`)と食い違った。判定は `tagColorKey` の 1 か所。
 * 🔑 描き直しを要らなくするために属性選択子で当てる(本文の HTML は色で変わらない)。
 * ⚠ 当てる先は **バッジだけ**(本文の `.pkc-tag` / 情報ペインの名前のボタン)。`data-pkc-tag` は
 *   「外す」ボタンなどにも付いているので、素の `[data-pkc-tag]` では書かない。
 * ⚠ 受け口でもタグを正規化して鍵を作り直す(壊れた入力の綴りをそのまま CSS に書かない)。
 *
 * 見せ方ごとの当て方は上の表のとおり。情報ペインは本文の見せ方の設定に従わず、いつも下地つき
 * (色を決めたことが一目で分かるように)。⚠ 塗るのは**名前のボタンだけ**
 * (包み全体を塗ると、幅の狭い右の列で「色」「色を外す」と一緒に折り返して高さが崩れる ── 実画面で確かめた)。
 */
export function tagColorCss(list: readonly TagColorEntry[]): string {
  const out: string[] = [];
  for (const { tag, color } of list) {
    const c = normalizeTagColor(color);
    const key = tagColorKey(tag);
    if (c === null || key === null) continue; // 受け口でも検める(壊れた値を CSS に書かない)
    const ink = tagInkFor(c);
    const t = `[data-pkc-tag-key="${cssString(key)}"]`;
    const body = `.pkc-tag${t}`;
    const insp =
      `[data-pkc-field="inspector-tag-find"]${t},[data-pkc-field="inspector-body-tag-find"]${t}`;
    const chip = `html:not([data-pkc-tag-badge="outline"]):not([data-pkc-tag-badge="plain"])`;
    out.push(
      `${chip} ${body}{background:${c};color:${ink};}` +
        `${chip} ${body}[data-pkc-action]:hover{background:${c};filter:brightness(0.92);}` +
        `html[data-pkc-tag-badge="outline"] ${body}{border:2px solid ${c};}` +
        insp
          .split(',')
          .map((x) => `${x}{background:${c};color:${ink};}`)
          .join(''),
    );
  }
  return out.join('\n');
}
