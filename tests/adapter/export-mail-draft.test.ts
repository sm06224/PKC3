/** @vitest-environment happy-dom */
/**
 * 🔴 **メール下書きをコピーする**(#1459 段②「コピペしてすぐ送れるメール下書き」)。
 *
 * 守る主張:
 * 1. 件名つきの読める字になり、別のノートの章が展開され、`{{vars}}` と入力欄の値が差し込まれる
 * 2. 押した配線(右クリック / 右の列の `copy-entry-mail`)が、押した行のノートの lid で届く
 * 3. 断る(編集中・ノートが無い・コピーできない)は理由を言い、黙って終わらない
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { copyEntryMailDraft, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const META = (lid: string, title: string, order: number) => ({
  lid,
  title,
  archetype: 'text',
  created_at: null,
  updated_at: null,
  entry_order: order,
  status: null,
  date: null,
  archived: 0,
});

const REPORT = [
  '---',
  'vars.氏名: 山田',
  'vars.件数: 12',
  '---',
  '# 週報',
  '',
  '担当: {{vars.氏名}}(**{{vars.件数}}** 件)',
  '',
  '![決定事項](entry:m1#h/決定事項)',
  '',
  '```yaml form',
  'fields:',
  '  - name: 氏名',
  '  - name: 件数',
  '```',
  '',
].join('\n');
const MEMO = '# メモ\n\n## 決定事項\n\n- 予算は承認\n\n## 別\n\n無関係\n';

function source(): ArchiveSource {
  const bodies = new Map([
    ['r1', REPORT],
    ['m1', MEMO],
  ]);
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [META('r1', '週報 2026-10-26', 1), META('m1', 'メモ', 2)],
    getBody: async (lid) => bodies.get(lid) ?? null,
    listBodies: async () => ({ rows: [], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

function rig() {
  const notices: string[] = [];
  const deps = {
    source: source(),
    download: () => {},
    report: () => {},
    settle: async () => {},
    renderFigure: async () => null,
    renderFigureVector: async () => null,
    renderIcon: async () => null,
    askSql: async () => {
      throw new Error('引かない');
    },
    notify: (m: string) => notices.push(m),
  } as unknown as ExportDeps;
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return { deps, d, notices };
}

describe('メール下書き', () => {
  it('🔴 件名つき・記号なし・章を展開・値を差し込んで、クリップボードへ渡す', async () => {
    const r = rig();
    const copied: string[] = [];
    const ok = await copyEntryMailDraft(r.d, r.deps, 'r1', async (t) => {
      copied.push(t);
      return true;
    });
    expect(ok).toBe(true);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe(
      [
        '件名: 週報 2026-10-26',
        '',
        '【週報】',
        '',
        '担当: 山田(12 件)',
        '',
        '■ 決定事項',
        '',
        '・ 予算は承認',
        '',
        '氏名: 山田',
        '件数: 12',
        '',
      ].join('\n'),
    );
    expect(copied[0]).not.toContain('無関係'); // 次の章は入らない
    expect(r.notices.join('\n')).toContain('別のノートの章 1 件を展開しました');
  });

  it('🔴 コピーできなかったら、コピーしたと言わず理由を出す', async () => {
    const r = rig();
    const ok = await copyEntryMailDraft(r.d, r.deps, 'r1', async () => false);
    expect(ok).toBe(false);
    expect(r.d.getState().error).toContain('コピーできませんでした');
    expect(r.notices.join('\n')).not.toContain('コピーしました');
  });

  it('ノートが無ければ理由を出す', async () => {
    const r = rig();
    expect(await copyEntryMailDraft(r.d, r.deps, 'zzz', async () => true)).toBe(false);
    expect(r.d.getState().error).toContain('見つかりません');
  });

  it('🔴 編集中は断る(下書きの本文を保存したつもりにしない)', async () => {
    const r = rig();
    r.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ ...META('r1', '週報', 1) } as never],
      relations: [],
    });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'r1' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'r1', body: REPORT });
    r.d.dispatch({ type: 'START_EDIT' });
    let called = false;
    const ok = await copyEntryMailDraft(r.d, r.deps, 'r1', async () => {
      called = true;
      return true;
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
    expect(r.d.getState().error ?? '').not.toBe('');
  });
});

describe('配線', () => {
  it('🔴 右クリック / 右の列の copy-entry-mail は、選んでいるノートの lid で services.copyEntryMail へ届く', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'copy-entry-mail');
    root.append(btn);
    document.body.append(root);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [META('r1', '週報', 1) as never], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'r1' });
    const calls: string[] = [];
    bindActions(root, d, { copyEntryMail: (lid) => calls.push(lid) });
    btn.click();
    expect(calls).toEqual(['r1']);
  });
});
