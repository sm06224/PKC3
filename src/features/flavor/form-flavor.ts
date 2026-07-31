/**
 * form フレーバー: frontmatter フィールド群 + 本文(note)。
 * フィールドを機械可読な frontmatter に置くのは、将来領域(フォーム記入済み
 * データ → ダッシュボード / 帳票、正本 doc §10)の読み口を確保するため。
 */
import {
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterValue,
} from '../markdown/frontmatter';
import { NO_EXTRACT, type FlavorSpec } from './flavor-spec';

/** PKC2 form-presenter.ts と同じ寛容 parse。 */
function parsePkc2Form(body: string): { name: string; note: string; checked: boolean } {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    return {
      name: typeof p.name === 'string' ? p.name : '',
      note: typeof p.note === 'string' ? p.note : '',
      checked: p.checked === true,
    };
  } catch {
    return { name: '', note: '', checked: false };
  }
}

export const formFlavor: FlavorSpec = {
  archetype: 'form',
  extract: () => NO_EXTRACT,
  fromPkc2(body) {
    const form = parsePkc2Form(body);
    // 固定 2 フィールド(PKC2 の form は動的スキーマではない)。空値も明示的に書く
    // ── フィールド UI(P3-5+)が「未記入」と「フィールド不在」を区別できるように
    const meta: Record<string, FrontmatterValue> = {
      'form.name': form.name,
      'form.checked': form.checked,
    };
    const fm = serializeFrontmatter(meta);
    return form.note === '' ? fm : `${fm}\n${form.note}`;
  },
};

/** P3-5+ のフィールド UI が使う読み口(単一の解釈点をここに置く)。 */
export function readFormFields(body: string): { name: string; checked: boolean } {
  const { meta } = parseFrontmatter(body);
  return {
    name: typeof meta['form.name'] === 'string' ? meta['form.name'] : '',
    checked: meta['form.checked'] === true,
  };
}
