/**
 * 集計の「束ね方」を覚える(#184)。
 *
 * ⚠ **container に入れない** ── どの項目で束ねて見ていたかは**作業の都合**であって、
 * ノートのデータではない(ペインの開閉 `pkc3.panes` / テーマ `pkc3.theme` と同じ分け方)。
 * 🔴 PKC2 はここを取り違えて、表示の選択を container に書きながら**保存イベントを
 * 出さなかった**ため、「選んでリロードすると消える」状態で着地した。
 *
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 「覚えていない」に落ちる
 * (覚えられないより、開けないほうが害が大きい)。
 */

const KEY = 'pkc3.query-key';

/**
 * 覚える値の上限。⚠ frontmatter の key 名は短い ── 長い値が入っていたら
 * 壊れた保存なので**捨てる**(画面へ流さない)。
 */
const MAX_CHARS = 200;

function readStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class QueryKeyStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: string | null = null;

  constructor(
    private readonly storage: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    > | null = readStorage(),
  ) {}

  get(): string | null {
    try {
      const raw = this.storage?.getItem(KEY) ?? null;
      if (raw === null || raw === '' || raw.length > MAX_CHARS) return null;
      return raw;
    } catch {
      return this.fallback;
    }
  }

  /** ⚠ `null` は**消す**(空文字を書いて「空という選択」を作らない)。 */
  set(key: string | null): void {
    this.fallback = key !== null && key.length <= MAX_CHARS ? key : null;
    try {
      if (this.fallback === null) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, this.fallback);
    } catch {
      /* 保存できない環境 ── この session の控えだけで動く */
    }
  }
}

export const appQueryKey = new QueryKeyStore();
