/**
 * 埋め込みを許す origin の一覧(#189 / C-4 段①)。
 *
 * 🔴 **flag と分ける。** flag は「受け口を張るか」、こちらは「**誰に**開けるか」──
 * user 指示 2026-07-30「flags は…正規設定(settings)と分離する」に従い、
 * **相手の一覧は設定**である(15 枠を食わない)。
 *
 * ⚠ 既定は**空** ── flag を立てただけでは誰も通らない(fail-closed)。
 */

const KEY = 'pkc3.embed-origins';

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
  set(origins: readonly string[]): void {
    const out: string[] = [];
    for (const v of origins) {
      const n = normalize(v);
      if (n !== null && !out.includes(n)) out.push(n);
    }
    try {
      this.storage?.setItem(KEY, JSON.stringify(out));
    } catch {
      /* 書けなくても落とさない(次の起動で空に戻るだけ) */
    }
  }
}
