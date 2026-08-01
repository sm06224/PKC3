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
 * revisions は**持ち込む**(user 裁定 2026-08-01)── ただしここでは「古い順に
 * 並んだ変換済み全文」までを作り、逆向きパッチへの符号化は worker が行う。
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

/** 履歴 1 版(変換済み全文)。逆パッチ化は worker が行う。 */
export interface PendingRevision {
  body: string;
  /** PKC2 の created_at(履歴の時刻は捏造しない ── 空なら worker が現在時刻)。 */
  createdAt: string;
}

/** entry 1 件ぶんの履歴(**古い → 新しい**の順)。 */
export interface RevisionChain {
  entryLid: string;
  snapshots: PendingRevision[];
}

export interface ConvertResult {
  entries: ConvertedEntry[];
  relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>;
  assets: ConvertedAsset[];
  revisionChains: RevisionChain[];
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
  /**
   * asset の旧 key を **container の外**から渡す(ZIP 経路)。
   * package/bundle は bytes が ZIP entry にあり `container.assets` は空なので、
   * key だけをここで渡す ── 指定すると `container.assets` のキーより優先する。
   */
  assetKeys?: readonly string[];
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

/**
 * `<prefix><token>` を 1 パスで写す。
 *
 * ⚠ token は `[A-Za-z0-9_-]+` を**最長一致**で取る ── これが境界の実体である。
 * 貪欲でないと `asset:k10` の `k1` 部分だけが `k1` の写し先に化ける
 * (PKC2 の旧 key 3 系統は prefix 関係になりうるので実際に起きる)。
 * map に無い token はそのまま(missing key は壊れシグナルとして保存する)。
 */
function replacePrefixed(
  body: string,
  prefix: string,
  map: ReadonlyMap<string, string>,
): string {
  if (map.size === 0) return body;
  return body.replace(
    new RegExp(`${prefix}[A-Za-z0-9_-]+`, 'g'),
    (m) => prefix + (map.get(m.slice(prefix.length)) ?? m.slice(prefix.length)),
  );
}

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
  if (map.size === 0) return body;
  // 素の token を最長一致で拾って引く(map 全件ループをやめる ── review M-7)。
  // 暫定 key は `ast-<ts36>-<rand6>` なので、`-` を含む 1 token として取れる
  return body.replace(/[A-Za-z0-9_-]+/g, (t) => map.get(t) ?? t);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 解釈できない created_at は空にする(review L-12)。
 *
 * 「時刻は捏造しない」は正しいが、**壊れた時刻をそのまま信じるのは別問題** ──
 * この値は版の前後を決めるソートキーでもあるので、壊れていると鎖の順序が
 * 入れ替わる。空にすれば安定ソートが配列順(= PKC2 の追記順)へ落ちる。
 */
function validTimestamp(raw: string): string {
  return raw !== '' && !Number.isNaN(Date.parse(raw)) ? raw : '';
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

  // ── ① lid 衝突の再採番。
  // ⚠ 判定は **entry の出現ごと**に行う(review L-15)── lid を key にした Map
  // だけで持つと、PKC2 側に同じ lid が 2 つあったとき両方が同じ新 lid を指し、
  // bulk upsert の後勝ちで**片方が無言で消える**(実証済み)
  const finalLidAt: string[] = [];
  const lidMap = new Map<string, string>(); // 参照書換用(旧 lid → 新 lid、先勝ち)
  const taken = new Set(opts.existingLids);
  for (const u of users) {
    if (taken.has(u.lid)) {
      const next = opts.genLid();
      if (!lidMap.has(u.lid)) lidMap.set(u.lid, next);
      taken.add(next);
      finalLidAt.push(next);
      warnings.push(`lid 衝突を再採番: ${u.lid} → ${next}`);
    } else {
      taken.add(u.lid);
      finalLidAt.push(u.lid);
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
  for (const oldKey of opts.assetKeys ?? Object.keys(assetsIn)) {
    keyMap.set(oldKey, freshAssetKey());
  }
  // legacy 内蔵 data(body に base64 が入っていた旧形式)は **履歴の版数ぶん**
  // 現れる ── 同じ base64 に同じ暫定 key を配らないと、`assetsOut` が同一 bytes を
  // 版の数だけ**同時に**保持し、adapter がその回数だけ復号 + SHA-256 する
  // (review M-6: 添付 1 個 + 履歴 50 版で 51 件になっていた)。
  // disk 上は content addressing で 1 部に落ちるが、メモリと CPU は落ちない
  const legacyKeyByData = new Map<string, string>();

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
  users.forEach((u, i) => {
    if (u.archetype !== 'textlog') return;
    const converted = getFlavor('textlog').fromPkc2!(u.body);
    const anchors = buildTextlogAnchorMap(u.body, converted);
    anchorsByLid.set(finalLidAt[i]!, anchors);
    firstLogOfDay.set(finalLidAt[i]!, buildFirstLogOfDay(u.body, anchors));
  });

  // ── ③〜⑤ 1 本の body を PKC-Markdown へ写す(entry 本文にも履歴 snapshot にも
  // **同じ経路**を使う ── 別経路にすると履歴だけ JSON 文字列が残り、古い版の
  // asset 参照が書き換わらず GC に消される)
  const convertBody = (
    u: { lid: string; title: string; archetype: string },
    selfLid: string, // textlog の自己参照解決に使う(出現ごとの最終 lid)
    rawBody: string,
    quiet: boolean, // 履歴 snapshot では警告を出さない(件数ぶん増えるだけ)
  ): string => {
    let src = rawBody;
    if (u.archetype === 'attachment') {
      // ③ legacy data の externalize + keyMap 適用(JSON のまま前処理)
      try {
        const p = JSON.parse(src) as Record<string, unknown>;
        const data = str(p.data);
        if (data !== '') {
          let newKey = legacyKeyByData.get(data);
          if (newKey === undefined) {
            newKey = freshAssetKey();
            legacyKeyByData.set(data, newKey);
            assetsOut.push({
              key: newKey,
              oldKey: null, // PKC2 側に key が無い(body 内蔵だった)
              base64: data,
              mime: str(p.mime, 'application/octet-stream'),
            });
          }
          delete p.data;
          p.asset_key = newKey; // legacy は data 優先の規約だった ── bytes を正とする
          if (!quiet) warnings.push(`legacy 内蔵 data を asset 化: ${u.lid}`);
        } else {
          const k = str(p.asset_key);
          if (k !== '' && keyMap.has(k)) p.asset_key = keyMap.get(k);
          else if (k !== '' && !quiet) {
            // light export(assets 空)や subset export の閉包漏れ。旧 key のまま
            // 入るので開くまで気づけない ── 取込の時点で件数を言う(review M-7)
            warnings.push(
              `添付の中身がこの export に含まれていません: ${u.title || u.lid}`,
            );
          }
        }
        const icon = str(p.app_icon_asset_key);
        if (icon !== '' && keyMap.has(icon)) p.app_icon_asset_key = keyMap.get(icon);
        // 未知の `*_asset_key`(将来 field)は `attachment.extra` に verbatim 保全
        // されるので、**旧 PKC2 key を抱えたまま**残る = 死んだ参照(review L-13)。
        // 保全方針は変えないが、黙って死なせない
        if (!quiet) {
          for (const k of Object.keys(p)) {
            if (
              k.endsWith('_asset_key') &&
              k !== 'asset_key' &&
              k !== 'app_icon_asset_key' &&
              str(p[k]) !== ''
            ) {
              warnings.push(`未対応の添付参照は元のまま残ります: ${k}(${u.title || u.lid})`);
            }
          }
        }
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
      if (!quiet) warnings.push(`変換失敗(text として保持): ${u.lid}: ${String(e)}`);
      body = src;
    }
    // ⑤ 参照書換: lid → textlog permalink → asset key の順。
    // ⚠ map 全件を回して 1 件ずつ replace すると O(map 件数 × 本文量) になる
    // (review M-7: asset key 10 → 100 で 6.07 倍)。**1 パスで引く**
    body = replacePrefixed(body, 'entry:', lidMap);
    body = rewriteTextlogRefs(body, selfLid, anchorsByLid, firstLogOfDay);
    body = replacePrefixed(body, 'asset:', keyMap);
    return body;
  };

  const entries: ConvertedEntry[] = users.map((u, i) => ({
    lid: finalLidAt[i]!,
    title: u.title,
    archetype: u.archetype,
    body: convertBody(u, finalLidAt[i]!, u.body, false),
    entryOrder: 0, // 下で採番
  }));

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

  // ── 履歴(user 裁定 2026-08-01「revisions の考え方は持ち込む」)。
  // ⚠ **全文では積まない** ── P5c で決めた jujutsu 由来の鎖(tip = entries.body、
  // 履歴 = 逆向きパッチ)へ符号化する。符号化は bytes ではなく行の差分なので
  // 純関数では決められない部分が無く、ここでは「順に並んだ変換済み全文」まで作る。
  // 実際の逆パッチ化は worker(rev_order と隣接関係を持つ側)が行う
  // ⚠ 引きは Map で(review M-7)── `users.find` だと O(entry 数 × revision 数)。
  // 実測で entry 8,000 件 + revision 3,000 件の追加費用が 10 件時の 37.7 倍だった。
  // 同じ lid が複数あるときは**最初の出現**に付ける(PKC2 側の entry_lid が
  // どちらを指すか決められないため。再採番された 2 つ目以降には履歴が付かない)
  const userAt = new Map<string, number>();
  users.forEach((u, i) => {
    if (!userAt.has(u.lid)) userAt.set(u.lid, i);
  });
  const byLid = new Map<string, PendingRevision[]>();
  for (const raw of Array.isArray(c.revisions) ? c.revisions : []) {
    const r = raw as Record<string, unknown>;
    const lid = str(r.entry_lid);
    const at = userAt.get(lid);
    if (at === undefined) continue; // system entry / 除外済み entry の履歴は持ち込まない
    const target = finalLidAt[at]!;
    const list = byLid.get(target) ?? [];
    list.push({
      body: convertBody(users[at]!, target, str(r.snapshot), true),
      createdAt: validTimestamp(str(r.created_at)),
    });
    byLid.set(target, list);
  }
  const revisionChains: RevisionChain[] = [];
  for (const [entryLid, snapshots] of byLid) {
    // PKC2 は追記順だが、created_at があるならそれを正とする(古い → 新しい)。
    // 安定ソート(同時刻・時刻なしは元の並びを保つ)
    const ordered = snapshots
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.createdAt.localeCompare(b.s.createdAt) || a.i - b.i)
      .map((x) => x.s);
    revisionChains.push({ entryLid, snapshots: ordered });
  }

  return { entries, relations, assets: assetsOut, revisionChains, warnings };
}
