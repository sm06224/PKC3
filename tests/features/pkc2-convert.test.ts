/**
 * P6a: PKC2 → PKC3 純変換 core の pin。
 * variant を必ず持つ(ゼロ件次元を作らない): legacy data 直埋め / legacy log id /
 * lid 衝突 / 未知 kind relation / system entries / 履歴の持込。
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { readTags } from '../../src/features/flavor/tags';
import {
  convertPkc2Container,
  remapAssetKeys,
  type Pkc2Container,
} from '../../src/features/import/pkc2-convert';

function opts(existing: string[] = []) {
  let lidN = 0;
  let keyN = 0;
  return {
    existingLids: new Set(existing),
    orderBase: existing.length,
    genLid: () => `new-${++lidN}`,
    genAssetKey: () => `ast-new-${++keyN}`,
  };
}

const FIXTURE: Pkc2Container = {
  meta: { entry_order: ['b-note', 'a-todo'] },
  entries: [
    { lid: 'a-todo', title: 'やること', archetype: 'todo',
      body: '{"status":"done","description":"買い物 ![p](asset:ast-old-1)","date":"2026-08-01"}' },
    { lid: 'b-note', title: 'ノート', archetype: 'text',
      body: '参照 [t](entry:c-log#log/log-123-4) と [a](asset:ast-old-1)' },
    { lid: 'c-log', title: 'ログ', archetype: 'textlog',
      body: '{"entries":[{"id":"log-123-4","text":"記録","createdAt":"2026-07-01T09:00:00","flags":[]}]}' },
    { lid: 'd-att', title: '添付', archetype: 'attachment',
      body: '{"name":"p.png","mime":"image/png","size":3,"asset_key":"ast-old-1","launcher_url":"https://x"}' },
    { lid: 'e-legacy', title: '旧添付', archetype: 'attachment',
      body: '{"name":"old.bin","mime":"application/zip","data":"QUJD"}' },
    { lid: '__flags__', title: '', archetype: 'system-flags', body: '{"values":{}}' },
    { lid: '__settings__', title: '', archetype: 'system-settings', body: '{}' },
  ],
  relations: [
    { id: 'r1', from: 'b-note', to: 'a-todo', kind: 'structural' },
    { id: 'r2', from: 'b-note', to: '__flags__', kind: 'semantic' }, // 端点除外
    { id: 'r3', from: 'b-note', to: 'a-todo', kind: 'weird-kind' }, // 未知 kind
  ],
  assets: { 'ast-old-1': 'UE5H' },
  revisions: [
    // 履歴は **PKC2 形式の全文**(todo は JSON 文字列)── 本文と同じ経路で
    // 変換されなければ、復元したときに JSON が出てくる
    {
      id: 'v2',
      entry_lid: 'a-todo',
      created_at: '2026-07-02T00:00:00Z',
      snapshot: JSON.stringify({ status: 'open', description: '買い物(第2版)' }),
    },
    {
      id: 'v1',
      entry_lid: 'a-todo',
      created_at: '2026-07-01T00:00:00Z',
      snapshot: JSON.stringify({ status: 'open', description: '買い物(第1版)' }),
    },
    // 除外される system entry の履歴は持ち込まない
    { id: 'v0', entry_lid: '__settings__', created_at: '2026-07-01T00:00:00Z', snapshot: '{}' },
  ],
};

describe('convertPkc2Container (P6a)', () => {
  const r = convertPkc2Container(FIXTURE, opts());

  it('system entries を除外し、entry_order は meta.entry_order 優先で採番', () => {
    expect(r.entries.map((e) => e.lid)).toEqual([
      'b-note', 'a-todo', 'c-log', 'd-att', 'e-legacy', // order 指定 2 件が先頭
    ]);
    expect(r.entries.map((e) => e.entryOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('JSON body が全て PKC-Markdown 化される(JSON 文字列 body を作らない)', () => {
    for (const e of r.entries) {
      expect(e.body.trimStart().startsWith('{')).toBe(false);
    }
    const todo = r.entries.find((e) => e.lid === 'a-todo')!;
    const fm = parseFrontmatter(todo.body);
    expect(fm.meta['status']).toBe('done');
    expect(fm.meta['date']).toBe('2026-08-01');
  });

  it('asset key は全再採番され、本文参照と attachment frontmatter の両方が追従', () => {
    expect(r.assets.map((a) => a.key)).toContain('ast-new-1');
    const todo = r.entries.find((e) => e.lid === 'a-todo')!;
    expect(todo.body).toContain('asset:ast-new-1');
    expect(todo.body).not.toContain('ast-old-1');
    const att = r.entries.find((e) => e.lid === 'd-att')!;
    const fm = parseFrontmatter(att.body);
    expect(fm.meta['attachment.asset_key']).toBe('ast-new-1');
    // mime は attachment body から回収される
    expect(r.assets.find((a) => a.key === 'ast-new-1')?.mime).toBe('image/png');
    // launcher_url 等の拡張 field は保全される
    expect(fm.meta['attachment.launcher_url']).toBe('https://x');
  });

  it('legacy 内蔵 data は asset へ externalize され bytes が正になる', () => {
    const legacy = r.entries.find((e) => e.lid === 'e-legacy')!;
    const fm = parseFrontmatter(legacy.body);
    const newKey = fm.meta['attachment.asset_key'];
    expect(typeof newKey).toBe('string');
    const asset = r.assets.find((a) => a.key === newKey)!;
    expect(asset.base64).toBe('QUJD');
    expect(asset.mime).toBe('application/zip');
    expect(legacy.body).not.toContain('QUJD'); // body に base64 を残さない
  });

  it('textlog permalink が変換後見出し slug へ書き換わる(legacy log id)', () => {
    const note = r.entries.find((e) => e.lid === 'b-note')!;
    expect(note.body).toContain('entry:c-log#h/2026-07-01-090000');
    expect(note.body).not.toContain('#log/');
  });

  it('relations: 端点不在・未知 kind は警告付きで除外', () => {
    expect(r.relations).toEqual([
      { id: 'r1', fromLid: 'b-note', toLid: 'a-todo', kind: 'structural' },
    ]);
    // 🔴 内部の ID(r2 / r3)ではなく、ノートの題名で言う(#1087)
    expect(r.warnings).toContain('「ノート」から、つなぐ先のノートが無いつながりを除きました');
    expect(r.warnings).toContain(
      '「ノート」と「やること」の間の、種類の分からないつながり(weird-kind)を除きました',
    );
    expect(r.warnings.join('\n'), '内部の ID が出ている').not.toMatch(/\br[23]\b/);
  });

  it('履歴は持ち込む ── 古い → 新しい の順に並べ、本文と同じ経路で変換する', () => {
    // user 裁定 2026-08-01「revisions の考え方は持ち込む」+ P5c の鎖へ符号化
    expect(r.revisionChains).toHaveLength(1); // system entry の履歴は入らない
    const chain = r.revisionChains[0]!;
    expect(chain.entryLid).toBe('a-todo');
    expect(chain.snapshots.map((s) => s.createdAt)).toEqual([
      '2026-07-01T00:00:00Z',
      '2026-07-02T00:00:00Z',
    ]); // created_at 昇順(container の並びは逆だった)
    // JSON 文字列 body を履歴にも作らない
    for (const s of chain.snapshots) {
      expect(s.body).not.toContain('"status"');
      expect(s.body).toContain('買い物');
    }
    expect(chain.snapshots[0]!.body).toContain('第1版');
  });

  it('履歴 snapshot の asset 参照も書き換わる(GC に消されないため)', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          { lid: 'n', title: 'n', archetype: 'text', body: '今の本文\n' },
        ],
        assets: { 'old-k': 'QQ==' },
        revisions: [
          {
            id: 'v1',
            entry_lid: 'n',
            created_at: '2026-07-01T00:00:00Z',
            snapshot: '古い本文 ![x](asset:old-k)\n',
          },
        ],
      },
      opts(),
    );
    const snap = r2.revisionChains[0]!.snapshots[0]!.body;
    // 旧 key のまま残ると、GC の走査が content key を見つけられず bytes が消える
    expect(snap).toContain('asset:ast-new-1');
    expect(snap).not.toContain('asset:old-k');
  });

  it('lid 衝突は再採番され、entry: 参照と relations が追従する', () => {
    const r2 = convertPkc2Container(FIXTURE, opts(['a-todo']));
    const renamed = r2.entries.find((e) => e.title === 'やること')!;
    expect(renamed.lid).toBe('new-1');
    const note = r2.entries.find((e) => e.title === 'ノート')!;
    expect(note.body).not.toContain('entry:a-todo'); // 参照は残らない…そもそも無いが
    expect(r2.relations[0]).toMatchObject({ fromLid: 'b-note', toLid: 'new-1' });
    // 🔴 ノート 1 件ごとに「旧 → 新」を並べず、件数の 1 行に畳む
    // 🔴 題名で言う(#1643)── 件数だけだとどのノートか分からなかった
    expect(r2.warnings.filter((w) => w.includes('同じ ID でした'))).toEqual(['「やること」は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)']);
    expect(r2.warnings.join('\n'), '内部の ID を画面に出している').not.toContain('a-todo');
    // 対照群: 重なりが 2 件なら 1 行のまま題名が増える
    const r3 = convertPkc2Container(FIXTURE, opts(['a-todo', 'b-note']));
    expect(r3.warnings.filter((w) => w.includes('同じ ID でした'))).toEqual(['「やること」「ノート」は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)']);
  });

  it('🔴 古い形式の内蔵データの注意は、ID ではなく題名で言い、多いときは 1 行に畳む', () => {
    const legacy = (lid: string, title: string) => ({
      lid, title, archetype: 'attachment', body: '{"name":"o.bin","mime":"application/zip","data":"QUJD"}',
    });
    const one = convertPkc2Container(FIXTURE, opts());
    expect(one.warnings.filter((w) => w.startsWith('古い形式の内蔵データを添付にしました'))).toEqual([
      '古い形式の内蔵データを添付にしました: 「旧添付」',
    ]);
    const many = convertPkc2Container(
      { ...FIXTURE, entries: [legacy('x1', '一'), legacy('x2', ''), legacy('x3', '三'), legacy('x4', '四'), legacy('x5', '五')], relations: [], revisions: [] },
      opts(),
    );
    const lines = many.warnings.filter((w) => w.startsWith('古い形式の内蔵データを添付にしました'));
    expect(lines, '5 件が 5 行に並んでいる').toEqual([
      '古い形式の内蔵データを添付にしました: 「一」、題名の無いノート、「三」 ほか 2 件',
    ]);
    expect(many.warnings.join('\n'), '内部の ID が画面に出ている').not.toMatch(/x[1-5]/);
  });

  it('asset key の採番が衝突したら引き直す(無言の上書きを作らない)', () => {
    // 実体は `ast-<ts36>-<rand6>` ── 取込は同一 ms 内に何千件も採番するので、
    // 実効エントロピーは 6 文字 base36 のみ。衝突すると putBlob が後勝ちで
    // 上書きし、2 つの添付が同じ bytes を指す(review M-8)
    let n = 0;
    const collide = { ...opts(), genAssetKey: () => (++n <= 2 ? 'ast-DUP' : `ast-ok-${n}`) };
    const r2 = convertPkc2Container(
      { entries: [], assets: { k1: 'QQ==', k2: 'Qg==' } },
      collide,
    );
    const keys = r2.assets.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length); // 一意
  });

  it('app_icon_asset_key も keyMap で書き換わる(死んだ参照を残さない)', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          {
            lid: 'app',
            title: 'app',
            archetype: 'attachment',
            body: JSON.stringify({
              name: 'app.html',
              mime: 'text/html',
              asset_key: 'k-body',
              app_icon_asset_key: 'k-icon',
              registered_as_app: true,
            }),
          },
        ],
        assets: { 'k-body': 'QQ==', 'k-icon': 'Qg==' },
      },
      opts(),
    );
    const fm = parseFrontmatter(r2.entries[0]!.body).meta;
    expect(fm['attachment.asset_key']).toBe('ast-new-1');
    expect(fm['attachment.app_icon_asset_key']).toBe('ast-new-2');
    expect(r2.warnings).toEqual([]); // 解決できたので欠損警告は出ない
  });

  it('relation id は既存衝突 / id 欠落で再採番される', () => {
    const base = {
      entries: [
        { lid: 'p', title: 'p', archetype: 'text', body: 'p\n' },
        { lid: 'q', title: 'q', archetype: 'text', body: 'q\n' },
      ],
      relations: [
        { id: 'dup', from: 'p', to: 'q', kind: 'structural' },
        { from: 'q', to: 'p', kind: 'semantic' },
      ],
    };
    let relN = 0;
    const r2 = convertPkc2Container(base, {
      ...opts(),
      existingRelationIds: new Set(['dup']),
      genRelationId: () => `rel-new-${++relN}`,
    });
    expect(r2.relations.map((x) => x.id)).toEqual(['rel-new-1', 'rel-new-2']);
  });

  it('bytes を伴わない asset 参照(light export)は件数で警告する', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          {
            lid: 'att',
            title: '見積.xlsx',
            archetype: 'attachment',
            body: JSON.stringify({ name: '見積.xlsx', mime: 'x', asset_key: 'gone' }),
          },
        ],
        assets: {},
      },
      opts(),
    );
    expect(r2.warnings.some((w) => w.includes('見積.xlsx'))).toBe(true);
  });

  it('[M-20] key が別 key の prefix でも取り違えない(旧 3 系統は prefix 関係になる)', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          { lid: 'n', title: 'n', archetype: 'text', body: '![a](asset:k1) ![b](asset:k10)\n' },
        ],
        assets: { k1: 'QQ==', k10: 'Qg==' },
      },
      opts(),
    );
    const body = r2.entries[0]!.body;
    // 境界が無いと `asset:k10` が `asset:<k1 の写し先>0` に化ける
    expect(body).toBe('![a](asset:ast-new-1) ![b](asset:ast-new-2)\n');
  });

  it('[I-8] `.` を含む key(ast-1.v2)は ast-1 と別の key として写す。無い key は手前の一致へ戻す', () => {
    const both = convertPkc2Container(
      {
        entries: [
          { lid: 'n', title: 'n', archetype: 'text', body: '![a](asset:ast-1) ![b](asset:ast-1.v2)\n' },
        ],
        assets: { 'ast-1': 'QQ==', 'ast-1.v2': 'Qg==' },
      },
      opts(),
    );
    const [a, b] = both.assets;
    expect(a!.key).not.toBe(b!.key); // 前提: 2 つは別の添付として採番されている
    const keyOf = (oldKey: string): string => both.assets.find((x) => x.oldKey === oldKey)!.key;
    // 直す前は `asset:ast-1.v2` が `asset:<ast-1 の写し先>.v2` に化けた
    expect(both.entries[0]!.body).toBe(
      `![a](asset:${keyOf('ast-1')}) ![b](asset:${keyOf('ast-1.v2')})\n`,
    );
    // ast-1.v2 が無いときは、`.` の手前(ast-1)までの一致へ戻す ── 文末の句点が付いた参照
    // (`asset:ast-1.`)を写せなくならないため、直す前と同じ挙動を残す
    const only = convertPkc2Container(
      {
        entries: [{ lid: 'n', title: 'n', archetype: 'text', body: '![a](asset:ast-1) と asset:ast-1. と asset:zzz.v2\n' }],
        assets: { 'ast-1': 'QQ==' },
      },
      opts(),
    );
    const k = only.assets[0]!.key;
    expect(only.entries[0]!.body).toBe(`![a](asset:${k}) と asset:${k}. と asset:zzz.v2\n`);
  });

  it('[M-20] remapAssetKeys も prefix 関係で取り違えない', () => {
    const map = new Map([
      ['ast-a1', 'ast-CONTENT-1'],
      ['ast-a10', 'ast-CONTENT-2'],
    ]);
    expect(remapAssetKeys('x ast-a1 y ast-a10 z', map)).toBe(
      'x ast-CONTENT-1 y ast-CONTENT-2 z',
    );
    // map に無い token は触らない(missing key は壊れシグナルとして保存する)
    expect(remapAssetKeys('ast-unknown', map)).toBe('ast-unknown');
  });

  it('[M-6] legacy 内蔵 data は履歴の版数ぶん積み上げない(同じ base64 は 1 件)', () => {
    const attBody = (data: string) =>
      JSON.stringify({ name: 'a.bin', mime: 'application/zip', data });
    const r2 = convertPkc2Container(
      {
        entries: [{ lid: 'att', title: 'a.bin', archetype: 'attachment', body: attBody('QUJD') }],
        revisions: Array.from({ length: 20 }, (_, i) => ({
          id: `r${i}`,
          entry_lid: 'att',
          created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          snapshot: attBody('QUJD'), // 同じ bytes
        })),
      },
      opts(),
    );
    // 21 件になっていると、adapter が 21 回復号 + 21 回 SHA-256 してから
    // 「同じ key だった」と気づく(disk は 1 部でもメモリと CPU は落ちない)
    expect(r2.assets).toHaveLength(1);
  });

  it('[L-15] PKC2 側に同じ lid が 2 つあっても entry を落とさない', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          { lid: 'dup', title: '一つ目', archetype: 'text', body: 'A\n' },
          { lid: 'dup', title: '二つ目', archetype: 'text', body: 'B\n' },
        ],
      },
      opts(['dup']), // 既存とも衝突させる
    );
    expect(r2.entries).toHaveLength(2);
    // 同じ新 lid を指すと bulk upsert の後勝ちで片方が無言で消える
    expect(new Set(r2.entries.map((e) => e.lid)).size).toBe(2);
  });

  it('[L-12] 解釈できない created_at は空にして配列順へ落とす', () => {
    const r2 = convertPkc2Container(
      {
        entries: [{ lid: 'n', title: 'n', archetype: 'text', body: 'いま\n' }],
        revisions: [
          { id: 'a', entry_lid: 'n', created_at: 'とんでもない文字列', snapshot: 'v1\n' },
          { id: 'b', entry_lid: 'n', created_at: '', snapshot: 'v2\n' },
        ],
      },
      opts(),
    );
    const snaps = r2.revisionChains[0]!.snapshots;
    expect(snaps.map((s) => s.createdAt)).toEqual(['', '']);
    expect(snaps.map((s) => s.body)).toEqual(['v1\n', 'v2\n']); // 追記順を保つ
  });

  it('[L-13] 未対応の *_asset_key は黙って死なせず警告に出す', () => {
    const r2 = convertPkc2Container(
      {
        entries: [
          {
            lid: 'att',
            title: 'x.png',
            archetype: 'attachment',
            body: JSON.stringify({
              name: 'x.png',
              mime: 'image/png',
              asset_key: 'k',
              thumbnail_asset_key: 'k-thumb', // 未知 field(extra へ verbatim 保全)
            }),
          },
        ],
        assets: { k: 'QQ==', 'k-thumb': 'Qg==' },
      },
      opts(),
    );
    expect(r2.warnings.some((w) => w.includes('thumbnail_asset_key'))).toBe(true);
  });
});

describe('タグ・日時・色の取り込み(#1087)', () => {
  const one = (extra: Record<string, unknown>, body = '本文') => ({
    entries: [{ lid: 'n1', title: '題', archetype: 'text', body, ...extra }],
  });

  it('🔴 tags は frontmatter の tags: に入り、PKC3 のタグとして読める(順序を保つ・重複と空は除く)', () => {
    const r = convertPkc2Container(one({ tags: ['請求', ' 家事 ', '請求', '', '家事'] }), opts());
    expect(readTags(r.entries[0]!.body)).toEqual(['請求', '家事']);
    expect(r.entries[0]!.body.endsWith('本文')).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('本文に既に tags: があれば、そこへ足す(置き換えない)', () => {
    const r = convertPkc2Container(one({ tags: ['b', 'A'] }, '---\ntags: [a]\n---\n本文'), opts());
    expect(readTags(r.entries[0]!.body)).toEqual(['a', 'b']);
  });

  it('対照群: tags が無い・空のノートは本文を 1 字も変えない', () => {
    const none = convertPkc2Container(one({}), opts());
    const empty = convertPkc2Container(one({ tags: [] }), opts());
    expect(none.entries[0]!.body).toBe('本文');
    expect(empty.entries[0]!.body).toBe('本文');
  });

  it('長すぎる・多すぎるタグは付けず、数を 1 行で言う', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const r = convertPkc2Container(one({ tags: ['x'.repeat(41), ...many] }), opts());
    expect(readTags(r.entries[0]!.body)).toHaveLength(32);
    const line = r.warnings.filter((w) => w.includes('タグ'));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('9 個'); // 長い 1 + 溢れた 8(40 - 32)
  });

  it('🔴 created_at / updated_at は DB の刻み(UTC・秒)で運ぶ。読めない・無いなら null', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: 'a', title: 'a', archetype: 'text', body: '', created_at: '2026-01-02T03:04:05.678Z', updated_at: '2026-02-03T04:05:06+09:00' },
          { lid: 'b', title: 'b', archetype: 'text', body: '', created_at: 'not a date' },
          { lid: 'c', title: 'c', archetype: 'text', body: '' },
        ],
      },
      opts(),
    );
    const by = (l: string) => r.entries.find((e) => e.lid === l)!;
    expect([by('a').createdAt, by('a').updatedAt]).toEqual(['2026-01-02 03:04:05', '2026-02-02 19:05:06']);
    expect([by('b').createdAt, by('b').updatedAt]).toEqual([null, null]);
    expect([by('c').createdAt, by('c').updatedAt]).toEqual([null, null]);
  });

  it('color_tag は運べないので、件数を 1 行で言う(無いノートは数えない)', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: 'a', title: 'a', archetype: 'text', body: '', color_tag: 'red' },
          { lid: 'b', title: 'b', archetype: 'text', body: '', color_tag: 'blue' },
          { lid: 'c', title: 'c', archetype: 'text', body: '', color_tag: null },
        ],
      },
      opts(),
    );
    expect(r.warnings.filter((w) => w.includes('カラータグ'))).toEqual([
      '2 件のノートに付いていたカラータグは取り込めませんでした(PKC3 にはまだ対応する項目がありません)',
    ]);
  });
});

describe('ID の扱いと注意のまとめ(#1087)', () => {
  it('🔴 ID の無いノートは黙って捨てず、件数を言う', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: '', title: 'a', archetype: 'text', body: '' },
          { title: 'b', archetype: 'text', body: '' },
          { lid: 'ok', title: 'c', archetype: 'text', body: '' },
        ],
      },
      opts(),
    );
    expect(r.entries.map((e) => e.lid)).toEqual(['ok']);
    expect(r.warnings).toContain('2 件のノートは ID が無かったので取り込めませんでした');
  });

  it('🔴 ファイルの中で ID が重なったら、最初の 1 件がその ID のまま残り、リンクも最初を指す', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: 'X', title: '一つ目', archetype: 'text', body: '' },
          { lid: 'X', title: '二つ目', archetype: 'text', body: '' },
          { lid: 'L', title: 'リンク', archetype: 'text', body: '[a](entry:X)' },
        ],
      },
      opts(),
    );
    const by = (t: string) => r.entries.find((e) => e.title === t)!;
    expect(by('一つ目').lid).toBe('X');
    expect(by('二つ目').lid).toBe('new-1');
    expect(by('リンク').body).toBe('[a](entry:X)');
    expect(r.warnings).toContain('1 件のノートは ID が重なっていたので付け直しました');
  });

  it('対照群: 既存のノートと重なったときは、リンクを新しい ID へ付け替える(最初の出現へ)', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: 'X', title: '一つ目', archetype: 'text', body: '' },
          { lid: 'X', title: '二つ目', archetype: 'text', body: '' },
          { lid: 'L', title: 'リンク', archetype: 'text', body: '[a](entry:X)' },
        ],
      },
      opts(['X']),
    );
    const by = (t: string) => r.entries.find((e) => e.title === t)!;
    expect(by('一つ目').lid).toBe('new-1');
    expect(by('二つ目').lid).toBe('new-2');
    expect(by('リンク').body).toBe('[a](entry:new-1)');
  });

  it('🔴 つながりの注意は理由ごとに件数の 1 行(1 本ずつ並べない)', () => {
    const r = convertPkc2Container(
      {
        entries: [
          { lid: 'a', title: 'A', archetype: 'text', body: '' },
          { lid: 'b', title: 'B', archetype: 'text', body: '' },
        ],
        relations: [
          { id: '1', from: 'a', to: 'gone1', kind: 'structural' },
          { id: '2', from: 'a', to: 'gone2', kind: 'structural' },
          { id: '3', from: 'b', to: 'gone3', kind: 'structural' },
          { id: '4', from: 'a', to: 'b', kind: 'weird' },
          { id: '5', from: 'b', to: 'a', kind: 'odd' },
        ],
      },
      opts(),
    );
    expect(r.warnings).toEqual([
      'つなぐ先のノートが無いつながり 3 本を除きました',
      '種類の分からないつながり 2 本(weird、odd)を除きました',
    ]);
  });
});
