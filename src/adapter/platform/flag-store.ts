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
  private readonly fromUrl: Record<string, boolean>;
  private stored: Record<string, boolean>;

  constructor(search = typeof location === 'object' ? location.search : '') {
    this.fromUrl = flagsFromUrl(search);
    this.stored = readStored();
  }

  /** いま効いている値(URL > 保存 > 既定)。 */
  values(): Record<string, boolean> {
    return resolveFlags(this.stored, this.fromUrl);
  }

  isOn(name: string): boolean {
    return this.values()[name] ?? false;
  }

  /** その flag が **URL で上書きされている**か(画面が「一時的」と出すため)。 */
  isFromUrl(name: string): boolean {
    return this.fromUrl[name] !== undefined;
  }

  /**
   * 保存して切り替える。⚠ URL で上書き中の flag を変えても**画面には効かない**ので、
   * 呼び手はそれを user に伝えること(`isFromUrl` を見る)。
   */
  set(name: string, on: boolean): void {
    this.stored = { ...this.stored, [name]: on };
    write({ ...this.stored });
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
