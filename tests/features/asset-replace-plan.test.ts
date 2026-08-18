/**
 * O4: 添付の版を差し替える**計画**(#88)。
 *
 * 守りたい主張:
 *  ① 🔴 **どこから参照していても新しい中身が出る**(user 裁定の中身)
 *  ② 🔴 **中身が同じなら何もしない**(保存しただけで版を積まない)
 *  ③ 🔴 **旧版は台帳に積まれ、上限が当たる**
 *  ④ 🔴 **取りこぼしを数える ── ただし台帳を「取りこぼし」と読まない**
 *  ⑤ 触る必要のないノートは edits に入らない(無駄な保存をしない)
 */
import { describe, expect, it } from 'vitest';
import { planSaveBack } from '../../src/features/asset/asset-replace-plan';
import {
  readVersions,
  serializeVersion,
  VERSIONS_KEY,
} from '../../src/features/flavor/attachment-versions';
import { serializeFrontmatter, spliceFrontmatterKeys } from '../../src/features/markdown/frontmatter';

const OLD = 'ast-old';
const NEW = 'ast-new';
const AT = '2026-08-11T09:00:00Z';

function attachBody(extra: Record<string, unknown> = {}): string {
  return serializeFrontmatter({
    'attachment.name': '報告書.docx',
    'attachment.mime': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'attachment.size': 100,
    'attachment.asset_key': OLD,
    ...extra,
  } as never);
}

function plan(bodies: Record<string, string>, over: Partial<Parameters<typeof planSaveBack>[0]> = {}) {
  return planSaveBack({
    targetLid: 'a1',
    oldKey: OLD,
    newKey: NEW,
    newHash: 'hh',
    newBytes: 222,
    /** ⚠ 既定は**元と違う綴り・違う種類**にする ── 同じにすると
     *  「書き戻していない」変異が素通りする(#214)。 */
    newName: '報告書.odt',
    newMime: 'application/vnd.oasis.opendocument.text',
    oldBytes: 100,
    savedAt: AT,
    bodies: new Map(Object.entries(bodies)),
    ...over,
  });
}

describe('planSaveBack', () => {
  it('🔴 添付ノートの frontmatter が新しい版を指す', () => {
    const p = plan({ a1: attachBody() });
    const edit = p.edits.find((e) => e.lid === 'a1')!;
    expect(edit.frontmatter!['attachment.asset_key']).toBe(NEW);
    expect(edit.frontmatter!['attachment.size']).toBe(222);
    expect(edit.frontmatter!['attachment.hash']).toBe('hh');
  });

  it('🔴 ほかのノートの本文の参照も一緒に移る(これが「崩れない」の中身)', () => {
    const p = plan({
      a1: attachBody(),
      n1: `# メモ\n\n![図](asset:${OLD})\n`,
      n2: `[資料](pkc://c1/asset/${OLD})`,
    });
    const n1 = p.edits.find((e) => e.lid === 'n1')!;
    const n2 = p.edits.find((e) => e.lid === 'n2')!;
    expect(n1.nextText).toContain(`asset:${NEW}`);
    expect(n1.nextText).not.toContain(OLD);
    expect(n2.nextText).toContain(`/asset/${NEW}`);
  });

  it('関係ないノートは edits に入らない(無駄な保存をしない)', () => {
    const p = plan({ a1: attachBody(), n1: '# ただのメモ' });
    expect(p.edits.map((e) => e.lid)).toEqual(['a1']);
  });

  it('🔴 中身が同じなら何もしない(保存しただけで版を積まない)', () => {
    const p = planSaveBack({
      targetLid: 'a1', oldKey: OLD, newKey: OLD, newHash: null, newBytes: 1,
      newName: '報告書.docx', newMime: 'application/msword',
      oldBytes: 1, savedAt: AT, bodies: new Map([['a1', attachBody()]]),
    });
    expect(p.unchanged).toBe(true);
    expect(p.edits).toEqual([]);
  });

  it('🔴 旧版が台帳に積まれる(自動履歴として)', () => {
    const p = plan({ a1: attachBody() });
    const lines = p.edits.find((e) => e.lid === 'a1')!.frontmatter![VERSIONS_KEY] as string[];
    expect(lines).toEqual([serializeVersion({
      savedAt: AT, kind: 'auto', assetKey: OLD, bytes: 100, label: '',
    })]);
  });

  it('🔴 台帳が世代の上限を超えたら、古いものから落ちる', () => {
    const old = [1, 2, 3, 4, 5, 6].map((d) =>
      serializeVersion({
        savedAt: `2026-08-0${d}T00:00:00Z`, kind: 'auto', assetKey: `ast-${d}`, bytes: 1, label: '',
      }));
    const p = plan({ a1: attachBody({ [VERSIONS_KEY]: old }) }, { limits: { keepGenerations: 3 } });
    const lines = p.edits.find((e) => e.lid === 'a1')!.frontmatter![VERSIONS_KEY] as string[];
    expect(lines.length, '3 世代に収まる').toBe(3);
    expect(p.dropped.length, '古い 4 件が外れる(旧 6 件 + 今回の 1 件 − 3)').toBe(4);
    // ⚠ **bytes はここでは消さない** ── 外れたことだけを返す
    expect(lines.join(' ')).toContain(OLD); // 今回積んだ版は最新なので残る
  });

  it('🔴 ほかの添付が使っている分も数える(1 つの添付に閉じない)', () => {
    // ⚠ **これが効いていないと上限が嘘になる**(変異試験 #5 で判明)。
    //    自分の履歴は 50MB しかないので、自分だけ見れば上限 120MB に収まる ──
    //    ほかが 100MB 使っていることを数えて初めて「落とす」判断になる
    const MB = 1024 * 1024;
    const base = { a1: attachBody() };
    const withoutOthers = plan(base, { oldBytes: 50 * MB, limits: { maxTotalBytes: 120 * MB } });
    expect(withoutOthers.dropped.length, '自分だけなら収まる').toBe(0);

    const withOthers = plan(base, {
      oldBytes: 50 * MB,
      otherBytes: 100 * MB,
      limits: { maxTotalBytes: 120 * MB },
    });
    expect(withOthers.dropped.length, 'ほかを数えると落とす必要が出る').toBe(1);
    expect(withOthers.overBudget, '落として収まった').toBe(false);
  });

  it('🔴 ほかの添付だけで上限を超えていたら、落とせないと言う', () => {
    // ⚠ 予約分は**落とせない**(無関係なノートの履歴を巻き添えにしない)ので、
    //    自分を空にしても超えたままになりうる ── そのときは黙らずに言う
    const MB = 1024 * 1024;
    const p = plan(
      { a1: attachBody() },
      { oldBytes: 1 * MB, otherBytes: 300 * MB, limits: { maxTotalBytes: 200 * MB } },
    );
    expect(p.overBudget).toBe(true);
  });

  it('🔴 逃がし文字入りの参照は「取りこぼし」として数える', () => {
    // ⚠ 狭い規則は当たらない ── だから**黙らずに件数を出す**
    const p = plan({ a1: attachBody(), n1: `![図](asset:${OLD.replace('-', '\\-')})` });
    expect(p.stale, '取りこぼした lid を名指しする').toContain('n1');
  });

  it('🔴 台帳の旧 key を「取りこぼし」と読まない(嘘の報告をしない)', () => {
    // ⚠ 素朴に広い走査で数えると**必ず**引っかかる ── 台帳はわざと旧 key を持つ
    const p = plan({ a1: attachBody() });
    expect(p.stale, '添付ノート自身を取りこぼし扱いしない').toEqual([]);
  });

  it('散文に key が出てくるだけのノートも「取りこぼし」ではない', () => {
    const p = plan({ a1: attachBody(), n1: `前の版の key は ${OLD} でした。` });
    expect(p.stale).toEqual([]);
    expect(p.edits.map((e) => e.lid), '書き換えもしない').toEqual(['a1']);
  });

  it('hash が無ければ key ごと消す(嘘の hash を残さない)', () => {
    const p = plan({ a1: attachBody() }, { newHash: null });
    expect(p.edits[0]!.frontmatter!['attachment.hash']).toBeUndefined();
  });

  it('🔴 計画を当てると、本文が実際に新しい版を指す(往復で確かめる)', () => {
    // ⚠ 「計画が正しい」だけでは足りない ── **当てた結果**を見る
    const p = plan({ a1: `${attachBody()}\n\n![自分の図](asset:${OLD})\n` });
    const e = p.edits.find((x) => x.lid === 'a1')!;
    const applied = spliceFrontmatterKeys(e.nextText ?? '', e.frontmatter!);
    expect(applied).toContain(`asset:${NEW}`);
    expect(applied).toContain(`attachment.asset_key: ${NEW}`);
    expect(applied, '古い key は frontmatter から消える').not.toContain(`asset_key: ${OLD}`);
    // 台帳は旧 key を持ったまま(bytes を生かすため)
    expect(readVersions(applied).map((v) => v.assetKey)).toEqual([OLD]);
  });
});
