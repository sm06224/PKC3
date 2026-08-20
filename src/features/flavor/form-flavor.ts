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
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';

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
  /**
   * 🔴 **frontmatter の `date` / `status` は、アーキタイプによらず効く**
   * (2026-08-20。user 指示「カレンダーを利用するための導線が不足している」の調査で判明)。
   *
   * ⚠ 直す前は `NO_EXTRACT` を返しており、**書いても列に入らなかった**。
   *   #276 で `text` だけを `extractSchedule` へ直したときに、
   *   **同型の 4 つが取り残された**(CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
   * 🔴 症状は「効かない」で済まない ── カレンダーの日を押すと
   *   ①本文には `date` が入る ②カレンダーには出ない ③もう一度押すと
   *   **「本文が変わっているため反映できませんでした」という嘘の理由**が出る
   *   (列が `null` のままなので、トグルが毎回「付ける」側を送り、
   *   2 回目の splice が同値 = 変化なしになる)④外すこともできない。
   * 🔑 **founding 裁定 2026-07-30「アーキタイプ = フレーバー(見せ方・編集の仕方)」**
   *   に照らすと、`date` の意味が archetype で変わるほうが誤りである
   *   ── 見せ方が違うだけで、**書いた日付は日付**である。
   * ⚠ 鍵の名前と受理形は `schedule-keys.ts` の 1 か所(判定を増やさない)。
   * ⚠ `archived` はここでは写さない ── 理由は `extractSchedule` の docstring。
   */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
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
