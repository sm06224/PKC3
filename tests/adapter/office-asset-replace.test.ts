/** @vitest-environment happy-dom */
/**
 * 🔴 **Office の保存でノートの添付が差し替わる**(#205 段 C)。
 *
 * ⚠ 観測点は「dispatch した」で止めない ── **disk に何が書かれたか**まで見る
 * (`planSaveBack` は 2026-08-16 まで**呼び出し元 0 件**のまま全 test 緑だった)。
 * 見るのは 3 つ:
 *
 * 1. 添付ノートの `attachment.asset_key` が新しい key になった
 * 2. **旧版が台帳(`attachment.history`)に積まれた**
 * 3. **別のノートに書かれた `asset:` 参照も**書き換わった(参照はどこにでも書ける)
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { readAttachmentMeta } from '../../src/features/flavor/attachment-flavor';

const tick = (ms = 20): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const DOC = [
  '---',
  'attachment.name: 報告書.odt',
  'attachment.mime: application/vnd.oasis.opendocument.text',
  'attachment.size: 100',
  'attachment.asset_key: ast-old',
  '---',
  '説明',
  '',
].join('\n');

function setup(bodies: Record<string, string>, metas: EntryMeta[]): {
  d: Dispatcher;
  bodies: Record<string, string>;
  writes: string[];
  /** 走査(`listBodies`)からだけ隠す lid ── 頁が切れた状態を作る。 */
  hideFromScan: Set<string>;
  /** カーソルが前へ進まない状態にする。 */
  stick(): void;
} {
  const store = { ...bodies };
  const writes: string[] = [];
  const hideFromScan = new Set<string>();
  let stuckCursor = false;
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    getBodies: async (lids) =>
      lids.filter((l) => store[l] !== undefined).map((l) => ({ lid: l, body: store[l]! })),
    // ⚠ **全文の走査**はここを通る(差し替えは参照を全ノートで直す)
    listBodies: async () =>
      stuckCursor
        ? // ⚠ **前へ進まないカーソル**(壊れた worker / 実装ミス)を模す
          {
            rows: Object.entries(store).map(([lid, body]) => ({ lid, body })),
            done: false,
            next: { entryOrder: 0, lid: 'a1' },
          }
        : {
            rows: Object.entries(store)
              .filter(([lid]) => !hideFromScan.has(lid))
              .map(([lid, body]) => ({ lid, body })),
            done: true,
          },
    persistEntry: async (e) => {
      writes.push(e.lid);
      store[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  return {
    d,
    bodies: store,
    writes,
    hideFromScan,
    stick: () => {
      stuckCursor = true;
    },
  };
}

const saved = (
  lid: string,
  key = 'ast-new',
  /** 差し替え後の綴りと中身の種類(#214)。⚠ 既定は**別の拡張子**にする ── 元と
   *  同じにすると「書き戻していない」変異が素通りする。 */
  name = '報告.docx',
  mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
): Parameters<Dispatcher['dispatch']>[0] => ({
  type: 'OFFICE_ASSET_SAVED',
  lid,
  newKey: key,
  newHash: 'h'.repeat(64),
  newBytes: 4242,
  newName: name,
  newMime: mime,
  savedAt: '2026-08-16T00:00:00.000Z',
});

describe('Office の保存でノートの添付が差し替わる', () => {
  it('🔴 添付ノートの key / 大きさ / hash が新しくなる', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.d.dispatch(saved('a1'));
    await tick();
    const fm = parseFrontmatter(h.bodies.a1!).meta;
    expect(fm['attachment.asset_key'], 'key が古いまま').toBe('ast-new');
    expect(fm['attachment.size']).toBe(4242);
    expect(fm['attachment.hash']).toBe('h'.repeat(64));
  });

  it('🔴 綴りと中身の種類も新しくなる(#214)── 読み手 5 面が同じ場所を見る', async () => {
    /**
     * 🔴 直す前は key / size / hash / history の 4 つしか書き戻しておらず、
     * `.odt` を `.docx` で上書き保存しても frontmatter は**古い綴りのまま**残った。
     * ⚠ いちばん効くのは **「Office で開く」** ── LO は**拡張子で filter を選ぶ**ので、
     * `報告.odt` という名前で docx を渡すと開けない。
     * 🔑 読み手は `readAttachmentMeta` 1 か所に寄っているので、**そこから見る**
     * (frontmatter の生の key を数えるだけだと、読み手が別 key を見ていても緑になる)。
     */
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    // 空振り防止 ── 差し替え前は**古い綴り**であること
    const before = readAttachmentMeta(h.bodies.a1!);
    expect(before.name, '前提が崩れている(既に新しい綴り)').not.toBe('報告.docx');
    h.d.dispatch(saved('a1'));
    await tick();
    const after = readAttachmentMeta(h.bodies.a1!);
    expect(after.name, '綴りが古いまま(ダウンロード名 / Office の filter が狂う)').toBe(
      '報告.docx',
    );
    expect(after.mime, '中身の種類が古いまま').toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('🔴 旧版が台帳に積まれる(戻せなくならない)', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.d.dispatch(saved('a1'));
    await tick();
    const hist = parseFrontmatter(h.bodies.a1!).meta['attachment.history'];
    expect(Array.isArray(hist), '台帳が配列で入っていない').toBe(true);
    // 1 版 = `savedAt|kind|assetKey|bytes|label`
    expect(String((hist as unknown[])[0])).toContain('ast-old');
    expect(String((hist as unknown[])[0])).toContain('2026-08-16T00:00:00.000Z');
  });

  it('🔴 別のノートに書かれた参照も書き換わる(参照はどこにでも書ける)', async () => {
    const h = setup(
      { a1: DOC, n1: 'これを見て [報告書](asset:ast-old) ね\n', n2: '無関係\n' },
      [meta('a1', 'attachment'), meta('n1', 'text'), meta('n2', 'text')],
    );
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.bodies.n1, '他ノートの参照が旧 key のまま(GC で切れる)').toContain('asset:ast-new');
    expect(h.bodies.n1).not.toContain('ast-old');
    // ⚠ 触っていないノートは**書き直さない**(全件を書き戻さない)
    expect(h.writes, '無関係なノートまで書いた').not.toContain('n2');
  });

  /**
   * 🔴 **全文の走査が添付ノート自身を返さなくても、差し替えは通る**
   * (変異試験で生き残って判明)。⚠ `planSaveBack` は
   * **`bodies` に target が入っていないと frontmatter の差し替えを 1 件も返さない**
   * ── 走査の頁が途中で切れただけで「保存したのに key が古いまま」になる。
   */
  it('🔴 走査が添付ノート自身を落としても、key は差し替わる', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    // 走査だけが a1 を返さない状態を作る(getBody は返す = disk には在る)
    h.hideFromScan.add('a1');
    h.d.dispatch(saved('a1'));
    await tick();
    expect(parseFrontmatter(h.bodies.a1!).meta['attachment.asset_key'], 'key が古いまま').toBe(
      'ast-new',
    );
  });

  it('中身が同じ(key が変わらない)なら 1 バイトも書かない / 苦情も出さない', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.d.dispatch(saved('a1', 'ast-old'));
    await tick();
    expect(h.writes, '版だけ積んで中身は同じ、を作った').toEqual([]);
    // ⚠ **異常ではない**(「取り込みました」は呼び側が出す)── 苦情を出すと
    //    user は保存が失敗したと思う
    expect(h.d.getState().error, '変わっていないだけなのに苦情を出した').toBe(null);
  });

  it('🔴 編集中は何も起きない(棚に残して撃ち直す側と対)', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a1', body: DOC });
    h.d.dispatch({ type: 'START_EDIT' });
    await tick();
    // 空振り防止 ── 本当に編集に入っているか(入っていなければこの test は無意味)
    expect(h.d.getState().phase, '編集に入れていない').toBe('editing');
    const before = h.writes.length;
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.writes.length, '編集中に書き戻した').toBe(before);
  });

  /**
   * 🔴 **添付でないノートへは、書かないだけでなく「何も起きない」**
   * (変異試験で生き残って判明)。⚠ 「書かない」だけを見ると、reducer の門を
   * 外しても effect 側が空振りして緑になる ── そのとき user には
   * **身に覚えのない苦情**が出る(「書き戻せません」)。
   */
  it('🔴 添付でないノート / 知らない lid では、書かないし苦情も出ない', async () => {
    const h = setup({ a1: DOC, t1: 'ただの文\n' }, [meta('a1', 'attachment'), meta('t1', 'text')]);
    h.d.dispatch(saved('t1'));
    await tick();
    expect(h.writes).toEqual([]);
    expect(h.d.getState().error, '添付でないノートで苦情が出た').toBe(null);
    h.d.dispatch(saved('nope'));
    await tick();
    expect(h.writes).toEqual([]);
    expect(h.d.getState().error, '知らない lid で苦情が出た').toBe(null);
  });

  /**
   * 🔴 **書き換え漏れは件数を出す**(2026-08-16、着地前レビュー R12)。
   * ⚠ 逃がし文字入りの参照(`asset:ast\-old`)は**狭い規則が当たらない**ので
   * 旧 key を指したまま残る ── 黙って「取り込みました」と言うと、GC が実体を
   * 消した時点で**切れた参照だけが残る**。`asset-ref-rewrite.ts` が
   * 「呼び側は数え直して user に出す」と明記している当の保証である。
   */
  it('🔴 書き換えられなかった参照は、件数を出す(黙って「差し替えました」と言わない)', async () => {
    const h = setup(
      { a1: DOC, n1: 'これ [報告書](asset:ast\\-old) ね\n' },
      [meta('a1', 'attachment'), meta('n1', 'text')],
    );
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.d.getState().error, '旧い参照が残ったのに黙っている').toContain(
      '旧い参照が残りました: 1 件',
    );
  });

  it('🔴 開いている本文は、その場で差し替わる(次に開き直すまで古い、を作らない)', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a1', body: DOC });
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.d.getState().openBody?.body, '画面の本文が古いまま').toContain('ast-new');
  });
});

/**
 * 🔴 **レビュー後に足した門**(2026-08-16、着地前レビュー R5 / R8)。
 * ⚠ どちらも 1 巡目の変異試験で**生き延びた** ── 「直した」だけでは守られない。
 */
describe('レビューで足した門', () => {
  /**
   * 🔴 **版の 200MB は容れ物全体で見る**(R5)。⚠ `otherBytes` を渡さないと
   * 上限が**この添付の中だけ**で閉じ、30MB × 5 世代 のノートが 10 件で 1.5GB に
   * なっても `overBudget` すら立たない(誰も気づけない)。
   */
  it('🔴 他の添付が使っている分を数える(数えないと上限が効かない)', async () => {
    // 別の添付ノートが、既に上限ちょうど(200MiB)ぶんの版を持っている。
    // ⚠ **上限は `200 * 1024 * 1024`**(= 209,715,200)── 「200MB」を
    //    200,000,000 と読むと**この test は何も見ずに緑になる**(実際 1 度そうなった)
    const other = [
      '---',
      'attachment.name: b.odt',
      'attachment.asset_key: ast-b',
      // ⚠ 時刻に `:` が入るので**引用する**(この repo のミニ YAML の規約)
      'attachment.history: ["2026-01-01T00:00:00.000Z|auto|ast-b0|209715200|"]',
      '---',
      '',
    ].join('\n');
    const h = setup({ a1: DOC, a2: other }, [meta('a1', 'attachment'), meta('a2', 'attachment')]);
    h.d.dispatch(saved('a1'));
    await tick();
    const hist = parseFrontmatter(h.bodies.a1!).meta['attachment.history'];
    // ⚠ 全体で 200MB を超えるので、**この保存の版は残らない**
    expect(hist, '他の添付の分を数えていない ── 上限が全体で効いていない').toBeUndefined();
    // ⚠ 他所の版は**巻き添えにしない**(数えるが落とさない)
    expect(String(h.bodies.a2)).toContain('ast-b0');
  });

  /**
   * 🔴 **前へ進まないカーソルで無限に回らない**(R8)。⚠ この鎖は単一 queue なので、
   * 回り続けると**以降の store effect が 1 件も走らなくなる**(保存も永続化も止まる)
   * ── 画面は生きているので user は気づけない。他の全走査 3 か所と同じ形。
   */
  it('🔴 前へ進まないカーソルで無限に回らない(止まって理由を出す)', async () => {
    const h = setup({ a1: DOC }, [meta('a1', 'attachment')]);
    h.stick();
    h.d.dispatch(saved('a1'));
    await tick(60);
    expect(h.d.getState().error, '止まったのに理由が出ない').toContain('書き戻せませんでした');
    expect(h.writes, '壊れた走査の結果で書いた').toEqual([]);
  });
});
