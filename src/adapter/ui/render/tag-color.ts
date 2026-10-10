/**
 * タグの色を画面に当てる(#1457)。意味論は `features/tag-color.ts`、保存は worker の
 * `listTagColors` / `putTagColor`(器に持つ ── 端末の好みではない)。
 *
 * 🔑 いまの色の一覧は**この module が 1 つだけ持つ**(情報ペインのバッジが「色を外す」を出すか、
 *   色を選ぶ窓の初めの色は何か、を引く口)。当てる CSS は `<style>` 1 本に組み直す ──
 *   本文の HTML は 1 文字も変わらないので、描き直しは要らない(`tag-badge.ts` と同じ考え方)。
 */
import {
  tagColorCss,
  tagColorKey,
  tagColorOf,
  type TagColorEntry,
} from '@features/tag-color';
import { iconButton } from './icons';

const STYLE_FIELD = 'tag-colors';

let current: readonly TagColorEntry[] = [];

/** いまの色の一覧(読むだけ)。 */
export function currentTagColors(): readonly TagColorEntry[] {
  return current;
}

/** そのタグの色(無ければ `null`)。 */
export function currentTagColor(tag: string): string | null {
  return tagColorOf(current, tag);
}

/**
 * 色の一覧を入れ替えて、画面に当て直す。
 * 情報ペインのバッジの「色を外す」は、色の有無で出し分ける(`syncTagColorControls`)。
 */
export function applyTagColors(doc: Document, list: readonly TagColorEntry[]): void {
  current = list;
  const css = tagColorCss(list);
  const found = doc.querySelector<HTMLStyleElement>(`style[data-pkc-field='${STYLE_FIELD}']`);
  if (css === '') {
    found?.remove();
  } else {
    const style = found ?? doc.createElement('style');
    if (found === null) {
      style.setAttribute('data-pkc-field', STYLE_FIELD);
      doc.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
  syncTagColorControls(doc);
}

/**
 * 情報ペインのバッジのうち、「色を外す」を出すのは**色を決めたタグだけ**。
 * ⚠ 押せない物を出さない(色の無いタグで押しても何も起きない = 無言の dead click)。
 */
export function syncTagColorControls(root: ParentNode): void {
  for (const btn of root.querySelectorAll<HTMLElement>('[data-pkc-action="tag-color-clear"]')) {
    const tag = btn.getAttribute('data-pkc-tag') ?? '';
    btn.hidden = tagColorKey(tag) === null || tagColorOf(current, tag) === null;
  }
}

/**
 * バッジに「色を引く鍵」(`data-pkc-tag-key`)を付ける。判定は `tagColorKey` の 1 か所
 * (本文のバッジ = `markdown-render.ts` と同じ鍵 ── CSS の `i` は ASCII だけの大小無視なので使わない)。
 */
export function setTagKey(el: HTMLElement, tag: string): void {
  const key = tagColorKey(tag);
  if (key !== null) el.setAttribute('data-pkc-tag-key', key);
}

/**
 * 情報ペインのバッジに添える 2 つの押し所(色を付ける / 色を外す)。
 *
 * 🔑 **付けられるなら外せる**(片道の操作を作らない)。「外す」は色が在るときだけ見える。
 * ⚠ どちらも**ノートの本文を書かない**(色は器のデータ)ので、編集中でも押せる。
 */
export function tagColorControls(tag: string): HTMLButtonElement[] {
  const pick = iconButton('tag-color-pick', '色', null);
  pick.setAttribute('data-pkc-tag', tag);
  pick.setAttribute('data-pkc-field', 'inspector-tag-color');
  pick.title = `「${tag}」のバッジに色を付けます(付けた色は他のノートの同じタグにも出ます)`;
  const clear = iconButton('tag-color-clear', '色を外す', null);
  clear.setAttribute('data-pkc-tag', tag);
  clear.setAttribute('data-pkc-field', 'inspector-tag-color-clear');
  clear.title = `「${tag}」のバッジの色を外します(灰色のバッジに戻ります)`;
  clear.hidden = tagColorOf(current, tag) === null;
  return [pick, clear];
}
