/**
 * 埋め込みを許す origin の一覧(#189 / C-4 段①)。
 *
 * 🔴 **flag と分ける。** flag は「受け口を張るか」、こちらは「**誰に**開けるか」──
 * user 指示 2026-07-30「flags は…正規設定(settings)と分離する」に従い、
 * **相手の一覧は設定**である(15 枠を食わない)。
 *
 * ⚠ 既定は**空** ── flag を立てただけでは誰も通らない(fail-closed)。
 */

import { parseEmbedOriginInput } from '@features/agent/embed-origin-input';

const KEY = 'pkc3.embed-origins';

/** 他のタブが書いたかを `storage` event の key で見分けるため、場所を名指しで出す。 */
export const EMBED_ORIGINS_KEY = KEY;

/** 変わった内容(`remove` の origin は、飛んでいる依頼を畳むために呼び手が使う)。 */
export interface EmbedOriginsChange {
  /** `external` = 別のタブ(storage event)が書き換えた。origin は空 ── 呼び手が前後の一覧を比べる。 */
  kind: 'add' | 'remove' | 'external';
  origin: string;
}

/** ⚠ 見た目で弾かない ── **形として origin であること**だけを見る。 */
function normalize(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  // 🔑 明示の万能札と、素性の無い相手は**そのまま**通す(判定は protocol 側)
  if (s === '*' || s === 'null') return s;
  try {
    const u = new URL(s);
    // ⚠ `https://a.test/path` を渡されても **origin へ落とす**
    //    (path 付きのまま貯めると、突合が永久に外れる)
    return u.origin;
  } catch {
    return null;
  }
}

export class EmbedOriginsStore {
  private readonly storage: Storage | null;
  private readonly listeners = new Set<(change: EmbedOriginsChange) => void>();

  /** 設定の画面から 1 件足した / 外したときに呼ぶ(#1407)。⚠ `set` は呼ばない(一括の書き戻し)。 */
  onChange(fn: (change: EmbedOriginsChange) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(change: EmbedOriginsChange): void {
    for (const fn of [...this.listeners]) fn(change);
  }

  /** 別のタブが書き換えたと分かったとき(`storage` event)に、画面と登録を合わせ直す合図を撃つ。 */
  notifyExternal(): void {
    this.emit({ kind: 'external', origin: '' });
  }

  /**
   * 1 件足す。`false` = 足せなかった(形が受けられない / 入っている / **書けなかった**)。
   * 🔴 受ける形は `parseEmbedOriginInput`(https と手元の http だけ)── 画面の外から呼ばれても同じ門を通す。
   * 🔴 書いた後に**読み直して**入っていることを確かめる(書けなかったのに「足した」と通知しない)。
   */
  add(origin: string): boolean {
    const parsed = parseEmbedOriginInput(origin);
    if (!parsed.ok) return false;
    const n = parsed.origin;
    const cur = this.list();
    if (cur.includes(n)) return false;
    if (!this.set([...cur, n]) || !this.list().includes(n)) return false;
    this.emit({ kind: 'add', origin: n });
    return true;
  }

  /**
   * 1 件外す。`true` = もう入っていない(元から無い場合も含む。通知は実際に外したときだけ)。
   * `false` = **書けず、まだ入っている**(許したままなので、外したと言ってはいけない)。
   */
  remove(origin: string): boolean {
    const cur = this.list();
    if (!cur.includes(origin)) return true;
    this.set(cur.filter((o) => o !== origin));
    if (this.list().includes(origin)) return false;
    this.emit({ kind: 'remove', origin });
    return true;
  }

  constructor(storage?: Storage | null) {
    this.storage =
      storage !== undefined ? storage : typeof localStorage !== 'undefined' ? localStorage : null;
  }

  /** 許す origin。⚠ 読めない / 壊れているときは**空**(= 全部拒否)を返す。 */
  list(): string[] {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== 'string') continue;
      const n = normalize(v);
      if (n !== null && !out.includes(n)) out.push(n);
    }
    return out;
  }

  /** 書く。⚠ 正規化してから貯める(読むたびに直さない)。 */
  set(origins: readonly string[]): boolean {
    const out: string[] = [];
    for (const v of origins) {
      const n = normalize(v);
      if (n !== null && !out.includes(n)) out.push(n);
    }
    if (this.storage === null) return false;
    try {
      this.storage.setItem(KEY, JSON.stringify(out));
      return true;
    } catch {
      /* 書けなくても落とさない ── 呼び手は返り値で知る */
      return false;
    }
  }
}

/** アプリ全体で 1 つ(設定の画面と `main.ts` が同じ listener 表を見る)。 */
export const appEmbedOrigins = new EmbedOriginsStore();
