/**
 * P6a: PKC2 container JSON → PKC3 スキーマの純変換 core(設計 doc §3)。
 *
 * 手順(順序が本体):
 *   ① lid 衝突の再採番(lidMap)
 *   ② textlog anchor 対応表(fromPkc2 より前段 ── log id は変換で消える)
 *   ③ attachment JSON の前処理: legacy data(base64 内蔵)の externalize +
 *      asset_key / app_icon_asset_key の keyMap 適用(fromPkc2 は data 入りを
 *      throw する契約なので、必ずこの前処理を通す)
 *   ④ flavor fromPkc2(JSON body 5 種 → PKC-Markdown。text 系は verbatim)
 *   ⑤ 参照書換: entry:<lid>(lidMap)→ textlog permalink → asset:<key>(keyMap)
 *   ⑥ __x__ reserved lid / system-* archetype の除外、entry_order の採番
 *
 * revisions は**捨てる**(P6 設計 §4 の既定 (b) ── user 裁定があれば追加)。
 * I/O は一切しない(HTML/ZIP の読取り・bytes decode・書込は adapter 側)。
 */
import { getFlavor } from '../flavor';
import {
  buildTextlogAnchorMap,
  buildFirstLogOfDay,
  rewriteTextlogRefs,
} from './textlog-anchors';

/** PKC2 container JSON の受理形(必要 field のみ・寛容)。 */
export interface Pkc2Container {
  meta?: { entry_order?: unknown };
  entries?: unknown[];
  relations?: unknown[];
  assets?: Record<string, string>;
  revisions?: unknown[];
}

export interface ConvertedEntry {
  lid: string;
  title: string;
  archetype: string;
  body: string;
  entryOrder: number;
}

/**
 * 取り込むべき bytes 1 件。
 *
 * ⚠ **key は「暫定」である**(user 指示 2026-08-01 の content addressing)。
 * 最終的な key は bytes のハッシュなので、**bytes を復号できる adapter しか
 * 決められない** ── ここは純関数なので決められない。convert は暫定 key で
 * body を書き換えておき、adapter が復号後に `remapAssetKeys` で本物へ置き換える。
 *
 * `oldKey` は PKC2 側の key(ZIP 経路では `assets/<oldKey>.bin` の突合に要る)。
 * legacy 内蔵 data から externalize したものは null(PKC2 側に key が無い)。
 */
export interface ConvertedAsset {
  /** 暫定 key。adapter が content key へ写した後は使わない。 */
  key: string;
  oldKey: string | null;
  base64: string;
  mime: string;
}

export interface ConvertResult {
  entries: ConvertedEntry[];
  relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>;
  assets: ConvertedAsset[];
  warnings: string[];
}

export interface ConvertOptions {
  /**
   * 既存 lid 集合(衝突は再採番)。
   * ⚠ **生存 entry だけでは足りない**(review H-1)── ゴミ箱の lid(entries に
   * 居ないが revisions を持つ)と衝突すると、その item がゴミ箱から消え、
   * 取り込んだ entry が他人の履歴を背負う。呼び出し側が両方を合わせて渡すこと。
   */
  existingLids: ReadonlySet<string>;
  /** 既存 entryOrder の最大値(採番はこの続き)。 */
  orderBase: number;
  /** 既存 relation id 集合(衝突は再採番 ── upsert が後勝ちで潰すため)。 */
  existingRelationIds?: ReadonlySet<string>;
  genLid(): string;
  genAssetKey(): string;
  genRelationId?(): string;
}

const RESERVED_LID = /^__.+__$/;
const KNOWN_RELATION_KINDS = new Set([
  'structural',
  'categorical',
  'semantic',
  'temporal',
  'provenance',
]);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 境界付き置換(key / lid は [A-Za-z0-9_-]+ ── 後続が同字種なら別 token)。 */
const tokenRe = (prefix: string, token: string): RegExp =>
  new RegExp(`${prefix}${esc(token)}(?![A-Za-z0-9_-])`, 'g');

/**
 * 暫定 asset key を最終 key(= 中身のハッシュ)へ写す。
 *
 * convert は純関数なので bytes を持たず、content key を決められない ──
 * adapter が復号後にこれを呼ぶ。body 中の出現箇所は 2 通りある:
 * ① markdown の `asset:<key>` ② frontmatter の `attachment.asset_key: <key>` /
 * `attachment.app_icon_asset_key: <key>`。②は素の値なので prefix 無しで消す。
 *
 * 暫定 key は**この取込で生成した token**であり、body 中では必ず `:` か空白の
 * 直後に現れる ── 前方境界を見なくても他の語の一部に当たらない。
 */
export function remapAssetKeys(body: string, map: ReadonlyMap<string, string>): string {
  let out = body;
  for (const [from, to] of map) {
    if (from === to) continue;
    out = out.replace(tokenRe('', from), to);
  }
  return out;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function convertPkc2Container(
  c: Pkc2Container,
  opts: ConvertOptions,
): ConvertResult {
  const warnings: string[] = [];
  const rawEntries = Array.isArray(c.entries) ? c.entries : [];
  const assetsIn = c.assets && typeof c.assets === 'object' ? c.assets : {};

  // ── ⑥ user entry の選別(system entries は変換しない)
  const users: Array<{ lid: string; title: string; archetype: string; body: string }> =
    [];
  for (const raw of rawEntries) {
    const e = raw as Record<string, unknown>;
    const lid = str(e.lid);
    const archetype = str(e.archetype, 'text');
    if (lid === '') continue;
    if (RESERVED_LID.test(lid) || archetype.startsWith('system-')) continue;
    users.push({ lid, title: str(e.title), archetype, body: str(e.body) });
  }

  // ── ① lid 衝突の再採番
  const lidMap = new Map<string, string>();
  const taken = new Set(opts.existingLids);
  for (const u of users) {
    if (taken.has(u.lid)) {
      const next = opts.genLid();
      lidMap.set(u.lid, next);
      taken.add(next);
      warnings.push(`lid 衝突を再採番: ${u.lid} → ${next}`);
    } else {
      taken.add(u.lid);
    }
  }
  const finalLid = (lid: string): string => lidMap.get(lid) ?? lid;

  // ── asset keyMap(旧 3 系統 + 派生をすべて新 1 規則へ)
  // ⚠ 生成値は検査する(review M-8)── 採番規則の実効エントロピーは 6 文字 base36 で、
  // 取込は同一 ms 内に何千件も採番する。衝突すると putBlob が後勝ちで上書きし、
  // 2 つの添付が同じ bytes を指す(無言のデータ消失)。lid 側と同じ規律を敷く
  const keyMap = new Map<string, string>();
  const takenKeys = new Set<string>();
  const freshAssetKey = (): string => {
    let k = opts.genAssetKey();
    for (let i = 0; takenKeys.has(k) && i < 1000; i++) k = opts.genAssetKey();
    if (takenKeys.has(k)) {
      // 1000 回引いて外れない = 生成器が壊れている。黙って上書きさせない
      throw new Error('asset key の採番が衝突し続けています(生成器の不具合)');
    }
    takenKeys.add(k);
    return k;
  };
  for (const oldKey of Object.keys(assetsIn)) keyMap.set(oldKey, freshAssetKey());

  // mime は attachment body 側が持つ(container.assets には無い)── 先に回収
  const mimeByOldKey = new Map<string, string>();
  for (const u of users) {
    if (u.archetype !== 'attachment') continue;
    try {
      const p = JSON.parse(u.body) as Record<string, unknown>;
      const k = str(p.asset_key);
      const m = str(p.mime);
      if (k !== '' && m !== '' && !mimeByOldKey.has(k)) mimeByOldKey.set(k, m);
    } catch {
      /* 非 JSON body は fromPkc2 側の寛容 parse に任せる */
    }
  }

  const assetsOut: ConvertedAsset[] = [];
  for (const [oldKey, newKey] of keyMap) {
    assetsOut.push({
      key: newKey,
      oldKey,
      base64: assetsIn[oldKey] ?? '',
      mime: mimeByOldKey.get(oldKey) ?? 'application/octet-stream',
    });
  }

  // ── ② textlog anchor 対応表(final lid を key に ── 参照書換は lid 書換より後)
  const anchorsByLid = new Map<string, Map<string, string>>();
  const firstLogOfDay = new Map<string, Map<string, string>>();
  for (const u of users) {
    if (u.archetype !== 'textlog') continue;
    const converted = getFlavor('textlog').fromPkc2!(u.body);
    const anchors = buildTextlogAnchorMap(u.body, converted);
    anchorsByLid.set(finalLid(u.lid), anchors);
    firstLogOfDay.set(finalLid(u.lid), buildFirstLogOfDay(u.body, anchors));
  }

  // ── ③〜⑤ 各 entry の変換と参照書換
  const entries: ConvertedEntry[] = [];
  for (const u of users) {
    let src = u.body;
    if (u.archetype === 'attachment') {
      // ③ legacy data の externalize + keyMap 適用(JSON のまま前処理)
      try {
        const p = JSON.parse(src) as Record<string, unknown>;
        const data = str(p.data);
        if (data !== '') {
          const newKey = freshAssetKey();
          assetsOut.push({
            key: newKey,
            oldKey: null, // PKC2 側に key が無い(body 内蔵だった)
            base64: data,
            mime: str(p.mime, 'application/octet-stream'),
          });
          delete p.data;
          p.asset_key = newKey; // legacy は data 優先の規約だった ── bytes を正とする
          warnings.push(`legacy 内蔵 data を asset 化: ${u.lid}`);
        } else {
          const k = str(p.asset_key);
          if (k !== '' && keyMap.has(k)) p.asset_key = keyMap.get(k);
          else if (k !== '') {
            // light export(assets 空)や subset export の閉包漏れ。旧 key のまま
            // 入るので開くまで気づけない ── 取込の時点で件数を言う(review M-7)
            warnings.push(
              `添付の中身がこの export に含まれていません: ${u.title || u.lid}`,
            );
          }
        }
        const icon = str(p.app_icon_asset_key);
        if (icon !== '' && keyMap.has(icon)) p.app_icon_asset_key = keyMap.get(icon);
        src = JSON.stringify(p);
      } catch {
        /* 非 JSON は fromPkc2 の寛容 parse に任せる */
      }
    }
    // ④ flavor 変換(fromPkc2 の無い flavor = text 系は verbatim)
    let body: string;
    try {
      body = getFlavor(u.archetype).fromPkc2?.(src) ?? src;
    } catch (e) {
      warnings.push(`変換失敗(text として保持): ${u.lid}: ${String(e)}`);
      body = src;
    }
    // ⑤ 参照書換: lid → textlog permalink → asset key の順
    for (const [oldLid, newLid] of lidMap) {
      body = body.replace(tokenRe('entry:', oldLid), `entry:${newLid}`);
    }
    body = rewriteTextlogRefs(body, finalLid(u.lid), anchorsByLid, firstLogOfDay);
    for (const [oldKey, newKey] of keyMap) {
      body = body.replace(tokenRe('asset:', oldKey), `asset:${newKey}`);
    }
    entries.push({
      lid: finalLid(u.lid),
      title: u.title,
      archetype: u.archetype,
      body,
      entryOrder: 0, // 下で採番
    });
  }

  // ── ⑥ entry_order: meta.entry_order(旧 lid 列)優先、無ければ配列順
  const orderSpec = Array.isArray(c.meta?.entry_order)
    ? (c.meta.entry_order as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;
  if (orderSpec) {
    const rank = new Map(orderSpec.map((lid, i) => [finalLid(lid), i]));
    entries.sort(
      (a, b) =>
        (rank.get(a.lid) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.lid) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  entries.forEach((e, i) => (e.entryOrder = opts.orderBase + i + 1));

  // ── relations(端点が変換集合に居ないものは捨てて警告)
  const lids = new Set(entries.map((e) => e.lid));
  const relations: ConvertResult['relations'] = [];
  // ⚠ relation id も lid と同じく再採番する(review H-2)。worker は
  // ON CONFLICT(cid, id) DO UPDATE なので、同じ id が来ると**上書き**される ──
  // 同じファイルを 2 回取り込むと 1 回目の関連が disk から消え、PKC2 の relation に
  // id が無ければ全部 '' で衝突して 1 本しか残らない(どちらも実証済み)
  const takenRelIds = new Set(opts.existingRelationIds ?? []);
  const genRelationId =
    opts.genRelationId ?? (() => `rel-${Math.random().toString(36).slice(2, 10)}`);
  for (const raw of Array.isArray(c.relations) ? c.relations : []) {
    const r = raw as Record<string, unknown>;
    const from = finalLid(str(r.from));
    const to = finalLid(str(r.to));
    const kind = str(r.kind);
    if (!lids.has(from) || !lids.has(to)) {
      warnings.push(`端点不在の relation を除外: ${str(r.id)}`);
      continue;
    }
    if (!KNOWN_RELATION_KINDS.has(kind)) {
      warnings.push(`未知 kind の relation を除外: ${str(r.id)} (${kind})`);
      continue;
    }
    let id = str(r.id);
    if (id === '' || takenRelIds.has(id)) {
      id = genRelationId();
      for (let i = 0; takenRelIds.has(id) && i < 1000; i++) id = genRelationId();
      if (takenRelIds.has(id)) {
        throw new Error('relation id の採番が衝突し続けています(生成器の不具合)');
      }
    }
    takenRelIds.add(id);
    relations.push({ id, fromLid: from, toLid: to, kind });
  }

  const revCount = Array.isArray(c.revisions) ? c.revisions.length : 0;
  if (revCount > 0)
    warnings.push(
      `PKC2 revisions ${revCount} 件は持ち込まない(P6 設計 §4 既定 (b))`,
    );

  return { entries, relations, assets: assetsOut, warnings };
}
