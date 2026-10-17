/**
 * textlog フレーバー: 日時見出し節の規約(`## YYYY-MM-DD HH:mm:ss`)。
 * 追記 = 末尾への節 append(**P8 段⑥ で着地** ── `features/flavor/append-spec.ts` が
 * 「何を足すか」、`adapter/ui/actions/binder.ts` の `append-section` が導線)。
 * ⚠ ここは長らく「P3-5 で編集 UI が実装」と書いていたが、**その UI は存在しなかった**
 * (マニュアルも同じ嘘を書いていた)。doc は書いた時ではなく次に読む時に正しくあること。
 *
 * 秒まで含めるのは PKC2 の textlog-readability-hardening の教訓
 * (高頻度ログの弁別に秒が要る)── 設計メモ §3 の `HH:mm` 表記はこの精度に更新。
 */
import { readTextlogEntries, type TextlogEntry } from '../textlog/textlog-body';
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';
import { logDayOfHeading } from '../textlog/log-days';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * ISO timestamp → 見出し用のローカル時刻表記。PKC2 の textlog UI 表示が
 * ローカル時刻だったため、変換もローカルで焼く(見出しは読み物であり、
 * ISO の機械可読性は変換時点で確定的に手放す)。不正 ISO は原文を残す。
 * export は P6 の textlog anchor 対応表(見出しテキストの再現)が使う。
 */
export function formatHeadingTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * 🔴 **日時が無い記録の行の見出し**(台帳 #1852 I2 / 依頼 158。Gemini 回答 = 推薦 ②)。
 * 直す前は、日時の無い行の見出しに**取り込んだ時刻**が入り、本当の日付と関係のない日の記録に見えた。
 * ⚠ 無い日時を作らない ── `(日時なし)` と書く。見出しは日時の形ではないので、この行は「章」として扱われる。
 */
export const UNDATED_LOG_HEADING = '(日時なし)';

/**
 * 変換で生成される見出しの字(`## ` の後ろ)。⚠ 取り込み時の見出しと、リンクの書き換え(`textlog-anchors.ts`)が
 * **同じ字**を期待しなければならないので、組み立てはここ 1 本(片方だけ直すと、リンクが行き先を見失う)。
 */
export function logRowHeadingText(e: Pick<TextlogEntry, 'createdAt' | 'flags' | 'undated'>): string {
  const star = e.flags.includes('important') ? ' ★' : '';
  return `${e.undated === true ? UNDATED_LOG_HEADING : formatHeadingTimestamp(e.createdAt)}${star}`;
}

/**
 * 🔴 **ログの 1 行の見出しか**(#1559)。⚠ ログ(`textlog`)の `##` で、字が日時の形のものだけ ──
 *   ログの中に user が書いた別の見出しは「章」のまま。判定はここ 1 本(右クリックの字と、行のリンクの理由が読む)。
 * 🔴 **秒の無い見出し(`## 2026-10-10 12:30 会議`)も行**(台帳 #1852 I2 / 依頼 160。Gemini 回答 = 推薦 ①)。
 *   直す前は秒まで書いた形(`12:30:00`)だけが行で、秒の無い見出しは「日ごとのまとまり」ではその日に入るのに、
 *   右クリックやリンクでは普通の章だった。**日ごとのまとまりと同じ読み方**(`logDayOfHeading`。見出しの頭の
 *   日時だけを見る ── ` ★` や題名が後ろに付いてよい)に寄せて、扱いを 1 本にした。実在しない日(`2026-13-45`)は行ではない。
 */
export function isLogRowHeading(archetype: string | undefined, level: number, text: string): boolean {
  return archetype === 'textlog' && level === 2 && logDayOfHeading(text) !== null;
}

export const textlogFlavor: FlavorSpec = {
  archetype: 'textlog',
  /**
   * ⚠ **ログの見出しの日時は、いまも列へ写さない** ── ログは複数日時を持つので、
   *   単一の `date` 列に詰めると歪む(展開が要件になったら P3-6 で別表を設計する)。
   * 🔑 ここで写すのは **user が frontmatter に書いた `date`** だけである
   *   ── 「導出した日付」と「書いた日付」は別物で、後者は archetype によらず効く。
   */
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
    // PKC2: JSON { entries: [{ id, text, createdAt, flags }] }(寛容 parse)。
    // ⚠ ログ id(ULID / legacy)は markdown へ持ち込まない ── 変換後は復元
    // 不能なので、PKC2 のログ単位 permalink の書換は **P6 import パイプライン内で
    // fromPkc2 より前**にしか置けない(ordering 制約 ── review #6)
    // ⚠ ログ text 中の `## <日時>` 形の行は実節見出しと識別不能(エスケープ
    // しない)。P8 段⑥ の追記は**末尾に足すだけ**で節を再解釈しない
    // (`appendAt` は既存本文を読まない ── 見出しの形を後から変えられない代わりに、
    //  本文が壊れる経路も無い。PKC2 は保存形が JSON で見出しは描画時生成だった)
    const log = readTextlogEntries(body);
    // 🔴 ログの JSON として読めない本文は**捨てずに本文として残す**(#1087。`flavor-spec.ts` の契約
    //   「不正 JSON を落とさない」/ todo の `parsePkc2Todo` と同じ向き)
    if (log === null) return body;
    return log.entries
      .map((e) => {
        const heading = `## ${logRowHeadingText(e)}`;
        return e.text === '' ? heading : `${heading}\n\n${e.text}`;
      })
      .join('\n\n');
  },
};
