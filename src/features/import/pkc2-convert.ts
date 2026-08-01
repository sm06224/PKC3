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

export interface ConvertedAsset {
  key: string;
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
  /** 既存 container の lid 集合(衝突は再採番)。 */
  existingLids: ReadonlySet<string>;
  /** 既存 entryOrder の最大値(採番はこの続き)。 */
  orderBase: number;
  genLid(): string;
  genAssetKey(): string;
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
  const keyMap = new Map<string, string>();
  for (const oldKey of Object.keys(assetsIn)) keyMap.set(oldKey, opts.genAssetKey());

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
          const newKey = opts.genAssetKey();
          assetsOut.push({
            key: newKey,
            base64: data,
            mime: str(p.mime, 'application/octet-stream'),
          });
          delete p.data;
          p.asset_key = newKey; // legacy は data 優先の規約だった ── bytes を正とする
          warnings.push(`legacy 内蔵 data を asset 化: ${u.lid}`);
        } else {
          const k = str(p.asset_key);
          if (k !== '' && keyMap.has(k)) p.asset_key = keyMap.get(k);
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
    relations.push({ id: str(r.id), fromLid: from, toLid: to, kind });
  }

  const revCount = Array.isArray(c.revisions) ? c.revisions.length : 0;
  if (revCount > 0)
    warnings.push(
      `PKC2 revisions ${revCount} 件は持ち込まない(P6 設計 §4 既定 (b))`,
    );

  return { entries, relations, assets: assetsOut, warnings };
}
