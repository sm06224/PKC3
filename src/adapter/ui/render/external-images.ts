/**
 * 外部画像の設定と、ノートごとの同意(2026-08-06。user 裁定)。
 *
 * > user 裁定 2026-08-06「**設定で常にオン / 常に確認 / 常にオフをとりましょう。**」
 *
 * 意味論(何が「外」か / CSP の形)は `features/markdown/external-images.ts` に
 * 置いてある。ここが持つのは**保存と、この session の同意**だけである。
 *
 * ## 保存の位置づけ
 *
 * ⚠ **flag ではない**(flag 枠 15 とは別。user 指示 2026-07-30「正規設定と分離」)。
 * ⚠ **container にも入れない** ── ノートのデータではなく**この端末の判断**である。
 *   入れると書出し / 取込 / 同期の意味論に巻き込まれ、他人のノートを取り込んだ
 *   だけで自分の設定が変わる。保存先は `theme.ts` と同じ `localStorage` の 1 鍵。
 * ⚠ 読めない環境(プライベートモード等で投げる)でも**落ちない** ── 既定に落ちる。
 *
 * ## ノートごとの同意は「この session だけ」
 *
 * 🔑 **覚えるのはタブを閉じるまで**(module の Set)。永続化しない ──
 * 「一度押したら以後ずっと」は user が忘れるうえ、本文は編集で**中身が変わる**
 * (同じノートに後から別の追跡画像が入っても、同意は生きたままになる)。
 * ⚠ 「読み込まない」を選んだことも覚える ── 覚えないと同じ帯が出続けて、
 *   結果として「うるさいから常にオン」へ追い込むことになる。
 */
import {
  DEFAULT_EXTERNAL_IMAGE_MODE,
  isExternalImageMode,
  type ExternalImageMode,
} from '@features/markdown/external-images';

/** ⚠ 1 鍵だけ(`theme.ts` と同じ作法)。 */
const KEY = 'pkc3.external-images';

/** ノートごとの答え。⚠ **この session だけ**(永続化しない)。 */
type Answer = 'allow' | 'deny';

export class ExternalImagePolicy {
  private mode: ExternalImageMode;
  private readonly answers = new Map<string, Answer>();
  /**
   * 箱が「CSP で画像を止めた」と申告してきたノート。
   * ⚠ 箱の中身は静的には読めないので、**実際に止まった**という事実だけが材料。
   */
  private readonly blockedBoxes = new Map<string, number>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage()) {
    this.mode = this.read();
  }

  private read(): ExternalImageMode {
    try {
      const v = this.storage?.getItem(KEY);
      return v !== null && v !== undefined && isExternalImageMode(v)
        ? v
        : DEFAULT_EXTERNAL_IMAGE_MODE;
    } catch {
      return DEFAULT_EXTERNAL_IMAGE_MODE;
    }
  }

  getMode(): ExternalImageMode {
    return this.mode;
  }

  /**
   * 設定を変える。⚠ **ノートごとの同意は捨てる** ── 設定を触った時点で
   * user の判断は上書きされている。残すと「常にオフにしたのにこのノートだけ
   * 出続ける」になる。
   * @returns 実際に変わったか(呼び側が描き直しの要否に使う)
   */
  setMode(mode: string): boolean {
    if (!isExternalImageMode(mode) || mode === this.mode) return false;
    this.mode = mode;
    this.answers.clear();
    try {
      this.storage?.setItem(KEY, mode);
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return true;
  }

  /** このノートで外部画像を読み込むか。⚠ **判定はここ 1 か所**。 */
  allows(lid: string): boolean {
    if (this.mode === 'always') return true;
    if (this.mode === 'never') return false;
    return this.answers.get(lid) === 'allow';
  }

  /**
   * user がこのノートについて答えた。
   * @returns 実際に変わったか(既に同じ答えなら false ── 無駄に描き直さない)
   */
  answer(lid: string, answer: Answer): boolean {
    if (this.answers.get(lid) === answer) return false;
    this.answers.set(lid, answer);
    return true;
  }

  /** まだ聞いていないか(帯を出すかの判断に使う)。 */
  unanswered(lid: string): boolean {
    return this.mode === 'ask' && !this.answers.has(lid);
  }

  /**
   * 箱が止めた件数を覚える(累計。同じ箱から何度も来る)。
   * @returns 帯の内容が変わったか
   */
  noteBlockedBox(lid: string, blocked: number): boolean {
    const prev = this.blockedBoxes.get(lid) ?? 0;
    if (blocked <= prev) return false;
    this.blockedBoxes.set(lid, blocked);
    return true;
  }

  blockedBoxCount(lid: string): number {
    return this.blockedBoxes.get(lid) ?? 0;
  }

  /** ノートの内容が変わった / 同意が出た ── 箱の申告は数え直す。 */
  forgetBlockedBoxes(lid: string): void {
    this.blockedBoxes.delete(lid);
  }
}

/**
 * アプリで共有する 1 個(`appJobMonitor` と同じ作法)。
 * ⚠ test / bench は **自分で `new` して注入する** ── ここは import 時に
 * `localStorage` を 1 度読むので、後から書いた値は反映されない。
 */
export const appExternalImages = new ExternalImagePolicy();

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/**
 * 確認の帯を組む(`ask` で、まだ聞いていないノートにだけ出る)。
 *
 * 🔑 **何が起きるのかを書く**。「外部画像を許可しますか」では判断できない ──
 * user が知りたいのは「**押すと相手に何が伝わるのか**」である。
 * ⚠ **設定への近道は置かない** ── 「今後は常に」を帯に置くと、いま見ている
 *   1 件の判断のつもりで**全ノートの既定**を変えてしまう(設定は設定の画面に在る)。
 *
 * @param images 読み込んでいない本文の画像の数
 * @param boxes 箱の中で止まった画像の数(累計)
 */
export function buildExternalImageBar(images: number, boxes: number): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-field', 'external-image-bar');
  bar.setAttribute('role', 'group');

  const text = document.createElement('p');
  text.setAttribute('data-pkc-field', 'external-image-note');
  const what =
    boxes === 0
      ? `外部の画像が ${images} 件あります。`
      : images === 0
        ? `HTML の中で外部の画像が ${boxes} 件止まっています。`
        : `外部の画像が ${images} 件、HTML の中に ${boxes} 件あります。`;
  text.textContent =
    `${what}読み込むと、相手のサーバーに「この端末がいまこれを開いた」ことが伝わります` +
    '(中身が見えなくても伝わります)。';
  bar.append(text);

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.setAttribute('data-pkc-action', 'allow-external-images');
  allow.textContent = 'このノートで読み込む';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.setAttribute('data-pkc-action', 'deny-external-images');
  deny.textContent = '読み込まない';
  bar.append(allow, deny);
  return bar;
}
