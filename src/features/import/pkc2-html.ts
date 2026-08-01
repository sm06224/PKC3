/**
 * P6b: PKC2 の単一 HTML export から container を取り出す(設計 doc §2)。
 *
 * 規律:
 * - **script は絶対に実行しない**。DOMParser で構文解析するだけ(PKC2 importer と
 *   同じ契約)。`innerHTML` にも入れない
 * - **regex で抜かない**。slot id(`#pkc-meta` / `#pkc-data`)で引く ──
 *   ビルド産物と runtime export の 2 変種で shell の作りが違っても、この
 *   contract だけは同一だから
 * - **黙って受理しない**: app / schema が合わなければ理由付きで失敗する。
 *   「読めたつもりで 0 件」が最悪の結果(user が取り込めたと誤解する)
 *
 * ⚠ asset の base64 復号はここでは**やらない**。呼び出し側(adapter)が
 * bytes として Blob へ直行させる ── 巨大な base64 文字列を feature 層に
 * 溜めない(PKC2 の +293MB 常駐と同型の穴を作らない)。
 */

/** PKC2 の `#pkc-data` に入っている構造(必要な部分だけ)。 */
export interface Pkc2Payload {
  container: unknown;
  /** light = assets 空 / full。asset_encoding は base64 か gzip+base64。 */
  exportMeta: {
    mode?: string;
    mutability?: string;
    assetEncoding?: 'base64' | 'gzip+base64';
  };
}

export class Pkc2ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pkc2ParseError';
  }
}

/** DOM の生成手段(worker / node では DOMParser が無いので注入可能にする)。 */
export type HtmlParse = (html: string) => Document;

const defaultParse: HtmlParse = (html) =>
  new DOMParser().parseFromString(html, 'text/html');

/**
 * 単一 HTML から `{ container, export_meta }` を取り出す。
 * 形が違えば **必ず throw**(部分的に読めた気にさせない)。
 */
export function parsePkc2Html(html: string, parse: HtmlParse = defaultParse): Pkc2Payload {
  const doc = parse(html);

  const meta = doc.getElementById('pkc-meta');
  if (!meta) {
    throw new Pkc2ParseError('PKC2 の HTML ではありません(#pkc-meta が無い)');
  }
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(meta.textContent ?? '');
  } catch {
    throw new Pkc2ParseError('#pkc-meta を解釈できません');
  }
  const m = metaJson as { app?: unknown; schema?: unknown };
  if (m.app !== 'pkc2') {
    throw new Pkc2ParseError(`PKC2 のファイルではありません(app=${String(m.app)})`);
  }
  // PKC2 の schema は全歴史を通じて 1(設計 doc §1)。未知の版は**明示 reject** ──
  // 「読めるところだけ読む」は静かなデータ欠損を作る
  if (m.schema !== 1) {
    throw new Pkc2ParseError(
      `未対応の PKC2 schema です(schema=${String(m.schema)} ── 対応は 1)`,
    );
  }

  const data = doc.getElementById('pkc-data');
  if (!data) {
    throw new Pkc2ParseError('コンテナが見つかりません(#pkc-data が無い)');
  }
  // PKC2 の退避は `json.replace(/<\/(script)/gi, '<\\/$1')` ── **JSON の `\/`
  // エスケープ**なので、復元は JSON.parse が行う。ここで文字列置換すると
  // ① case が潰れて `</SCRIPT>` を含む本文が静かに書き換わる ② 退避が `>` を
  // 要求しない形なので取りこぼす。置換を持たないことが正しい(review M-5)
  const raw = data.textContent ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Pkc2ParseError(`コンテナの JSON を解釈できません: ${String(e)}`);
  }

  const p = payload as { container?: unknown; export_meta?: Record<string, unknown> };
  if (!p.container || typeof p.container !== 'object') {
    throw new Pkc2ParseError('コンテナが空です');
  }
  const c = p.container as { meta?: unknown; entries?: unknown };
  // 最小 shape 検査(PKC2 importer と同じ厳しさ)。revisions は optional
  if (!c.meta || typeof c.meta !== 'object' || !Array.isArray(c.entries)) {
    throw new Pkc2ParseError('コンテナの形が想定と違います(meta / entries)');
  }

  const em = p.export_meta ?? {};
  const enc = em.asset_encoding;
  return {
    container: p.container,
    exportMeta: {
      mode: typeof em.mode === 'string' ? em.mode : undefined,
      mutability: typeof em.mutability === 'string' ? em.mutability : undefined,
      assetEncoding: enc === 'gzip+base64' ? 'gzip+base64' : 'base64',
    },
  };
}
