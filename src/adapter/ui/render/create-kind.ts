/**
 * 分割ボタンの ▼ で選んだ「作る種類」を、次の起動でも覚える(C15 / #1045。
 * #1038 段 0 の落差表 N1 ── user の報告ではなく、PKC2 と見比べてこちらが見つけた物)。
 *
 * ⚠ **container に入れない** ── 「いま何を作りたいか」は作業の都合であって、
 *   ノートのデータではない(`pkc3.query-key` / `pkc3.browse` と同じ分け方)。
 * ⚠ **「設定」ではなく「最後の操作の記録」**である ── だから
 *   `settings-file.ts` の「設定の持ち出し」(#414)には乗せない
 *   (`SKIPPED_KEYS` に why つきで足す)。持ち出すと、別の端末で
 *   「選んだことのない種類」が最初から選ばれた状態になる。
 *
 * 🔴 **有効性はここでは判定しない**(ここは覚えて返すだけ)。「いまも作れる種類か」は
 *   `CREATE_BUTTONS` / `SEALED_ARCHETYPES` を持つ呼び側(`shell.ts`)にしか
 *   分からない ── 版が変わって封印された・消えた種類を返しても、
 *   呼び側が既定(先頭)へ落とす。
 *
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 「覚えていない」に落ちる
 * (`store-fallback` の作法と同じ:`storage === null` を先に見る。`?.` だけに
 *  頼ると `catch` へ入らず控えが死んだ枝になる)。
 */

const KEY = 'pkc3.create-kind';

/** 覚える値の上限。⚠ archetype 名は短い ── 長い値は壊れた保存として捨てる。 */
const MAX_CHARS = 200;

function readStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class CreateKindStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: string | null = null;

  constructor(
    private readonly storage: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    > | null = readStorage(),
  ) {}

  /** ⚠ 壊れた値(空・長すぎ)は `null`。有効な archetype かは呼び側が見る。 */
  get(): string | null {
    try {
      if (this.storage === null) return this.fallback;
      const raw = this.storage.getItem(KEY);
      if (raw === null || raw === '' || raw.length > MAX_CHARS) return null;
      return raw;
    } catch {
      return this.fallback;
    }
  }

  /** ⚠ `null` は**消す**(空文字を書いて「空という選択」を作らない)。 */
  set(archetype: string | null): void {
    this.fallback =
      archetype !== null && archetype.length > 0 && archetype.length <= MAX_CHARS
        ? archetype
        : null;
    try {
      if (this.fallback === null) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, this.fallback);
    } catch {
      /* 保存できない環境 ── この session の控えだけで動く */
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appCreateKind = new CreateKindStore();
