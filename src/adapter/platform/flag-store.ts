/**
 * フラグの保存と URL からの一時有効化(P11。user 指示 2026-08-07)。
 *
 * 🔑 **登記所は `features/flags.ts`(pure)、browser に触るのはここ**。
 * 層規約(`features` は純関数)を守るための分割で、`resolveFlags` /
 * `prunedForStorage` の判断は向こうに 1 つだけ在る。
 *
 * ## 保存先は localStorage の 1 鍵(user 裁定 2026-08-07 Q6)
 *
 * ⚠ sqlite の `flags` 表は**使わない**。使うと三すくみになる ──
 * ① `tests/flag-budget.test.ts` が「登記所以外は `flags` 表を触るな」と要求する
 * ② SQL は `storage-worker.ts` にしか無い
 * ③ 登記所は `features` 層なので storage を持てない。
 * localStorage なら **①②③ のどれとも衝突しない**。
 *
 * ⚠ **アプリのデータに混ぜない**(`theme.ts` と同じ判断)── container に入れると
 * export / import / 同期の意味論に巻き込まれる。開発者の切替はその端末のものである。
 *
 * ⚠ 保存が読めない環境(プライベートモード等で `localStorage` が投げる)でも
 * **アプリは動く** ── 既定に落ちるだけ。
 */
import { prunedForStorage, registeredFlags, resolveFlags } from '@features/flags';

/**
 * ⚠ **1 鍵だけ**(JSON)。flag ごとに鍵を切ると、退役したときに掃除が要る。
 * `theme.ts:44` の「1 キーだけ。増やすなら設定機構を建ててからにする」の釘は、
 * P11 で**設定機構を建てた**ことで満たしている(本 file がその一部)。
 */
const KEY = 'pkc3.flags';

/** URL の綴り。⚠ `?pkc-flag=name` / `?pkc-flag=name:off` の 2 形。 */
const URL_PARAM = 'pkc-flag';

function readStored(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {}; // 壊れていても落ちない ── 既定に戻るだけ
  }
}

function write(values: Readonly<Record<string, boolean>>): void {
  try {
    const pruned = prunedForStorage(values);
    // ⚠ 空なら**鍵ごと消す**(空 object を残すと「触った跡」だけが残る)
    if (Object.keys(pruned).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(pruned));
  } catch {
    // 保存できないだけ。この session では効いている
  }
}

/**
 * 🔴 **URL からの一時有効化**(パワーユーザーの逃げ道)。
 *
 * `?pkc-flag=live` で ON、`?pkc-flag=live:off` で OFF。複数指定可。
 * ⚠ **保存しない** ── URL を外せば元に戻る。「試して、閉じれば戻る」が要点で、
 *   保存すると**戻し方が分からない状態**を作ってしまう。
 * ⚠ 知らない名前は黙って捨てる(`resolveFlags` が登記所の名前だけを見る)。
 */
export function flagsFromUrl(search: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    for (const raw of new URLSearchParams(search).getAll(URL_PARAM)) {
      for (const token of raw.split(',')) {
        const t = token.trim();
        if (t === '') continue;
        const off = t.endsWith(':off');
        out[off ? t.slice(0, -':off'.length) : t] = !off;
      }
    }
  } catch {
    // 読めない URL は無視する
  }
  return out;
}

/**
 * flag の現在値を持ち、変更を保存する。
 * ⚠ **URL 由来は保存に混ぜない** ── 混ぜると URL を外しても残る。
 */
export class FlagStore {
  /**
   * ⚠ **URL は読むたびに見る**(固定の文字列を渡されたときを除く)。
   *
   * 直す前は constructor で 1 度だけ読んでいたが、`appFlags` は module の読み込み時に
   * 作られるので、**その後に URL が変わっても効かなかった**(実際に test が落ちた)。
   * URL の上書きは「いま効いている値」の一部なので、解決のたびに見るのが正しい。
   * ⚠ 同じ文字列なら**解析結果を使い回す**(描画のたびに呼ばれる)。
   */
  private readonly readSearch: () => string;
  private urlCache: { search: string; parsed: Record<string, boolean> } | null = null;
  private stored: Record<string, boolean>;

  constructor(search?: string) {
    this.readSearch =
      search !== undefined ? () => search : () => (typeof location === 'object' ? location.search : '');
    this.stored = readStored();
  }

  private get fromUrl(): Record<string, boolean> {
    const search = this.readSearch();
    if (this.urlCache?.search !== search) {
      this.urlCache = { search, parsed: flagsFromUrl(search) };
    }
    return this.urlCache.parsed;
  }

  /** いま効いている値(URL > 保存 > 既定)。 */
  values(): Record<string, boolean> {
    return resolveFlags(this.stored, this.fromUrl);
  }

  isOn(name: string): boolean {
    return this.values()[name] ?? false;
  }

  /**
   * 🔴 **URL が保存値と食い違っているか**(= 手で打たれた一時上書き)。
   *
   * ⚠ **「URL に載っているか」で判定してはいけない**(2026-08-08 に実際に踏んだ)。
   * 起動前に要る flag を ON にすると、**アプリ自身が** `?pkc-flag=…` を付けて
   * 読み込み直す。それを「上書き」と読むと、次の画面で
   * **アプリが自分の付けた URL を理由に操作を断る** ── 一度 ON にしたら
   * 二度と OFF にできない袋小路になっていた(「すべて既定へ戻す」も URL が
   * 残るので効かない)。
   * 🔑 食い違っているときだけが「外から手で上書きされた」である。
   */
  isFromUrl(name: string): boolean {
    const url = this.fromUrl[name];
    if (url === undefined) return false;
    const flag = registeredFlags().find((f) => f.name === name);
    const saved = this.stored[name] ?? flag?.default ?? false;
    return url !== saved;
  }

  /** URL に flag のパラメータが載っているか(再起動で消すべきかの判断)。 */
  hasUrlFlags(): boolean {
    return Object.keys(this.fromUrl).length > 0;
  }

  /**
   * 保存して切り替える。⚠ URL で上書き中の flag を変えても**画面には効かない**ので、
   * 呼び手はそれを user に伝えること(`isFromUrl` を見る)。
   */
  set(name: string, on: boolean): void {
    this.stored = { ...this.stored, [name]: on };
    write({ ...this.stored });
  }

  /**
   * 🔴 **起動前に要る flag のために、パラメータ付きの URL を組む**
   * (user 指示 2026-08-07「フラグ画面から再起動した際にパラメータありで再起動する」)。
   *
   * ⚠ **user に URL を手で打たせない。** 打たせると、それが抜け穴に戻る。
   * ⚠ 既定と同じものは載せない(URL が無用に長くならない)。
   * ⚠ **他のクエリは保つ** ── パーマリンクで開いている最中に再起動しても、
   *   見ていたものを見失わない。
   */
  restartUrl(href: string): string {
    const url = new URL(href);
    url.searchParams.delete(URL_PARAM);
    // 🔴 **保存値から組む**(`values()` から組まない)。
    // ⚠ `values()` は URL 由来を含むので、それを載せ直すと**自分が付けた URL が
    //   永久に生き残る** ── 既定へ戻しても消えない(2026-08-08 に踏んだ)。
    const pruned = prunedForStorage({ ...this.resolvedFromStored() });
    const tokens = registeredFlags()
      .filter((f) => f.needsRestart === true && pruned[f.name] !== undefined)
      .map((f) => (pruned[f.name] === true ? f.name : `${f.name}:off`));
    if (tokens.length > 0) url.searchParams.set(URL_PARAM, tokens.join(','));
    return url.toString();
  }

  /** 保存値だけで解いた値(URL を混ぜない)。再起動の URL を組むのに使う。 */
  private resolvedFromStored(): Record<string, boolean> {
    return resolveFlags(this.stored);
  }

  /** すべて既定へ戻す(パワーユーザーの避難口)。 */
  reset(): void {
    this.stored = {};
    write({});
  }

  /** 既定と違う値を持っている flag の数(画面の見出しに出す)。 */
  changedCount(): number {
    return Object.keys(prunedForStorage(this.values())).length;
  }
}

/** 宣言されている flag(画面が一覧に使う。登記所の再輸出)。 */
export { registeredFlags };

/**
 * 🔴 **アプリ共有の 1 個**(P11)。
 *
 * ⚠ **flag を読む側は必ずこれを引く** ── `location.search` を直に読むと、
 * それが「クエリパラメータの抜け穴」になる(user 指示 2026-08-07。不可侵)。
 * `tests/features/flags.test.ts` の全数検査が、読んでよい場所を 2 つに限っている
 * (flag の解決 と パーマリンク / ディープリンク)。
 */
export const appFlags = new FlagStore();
