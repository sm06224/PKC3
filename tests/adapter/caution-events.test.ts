/** @vitest-environment happy-dom */
/**
 * #1017: メッセージの種類「注意」として積む出来事 2 つ(保存先の空きが少ない /
 * 別のタブが同じノートを編集中)。
 *
 * 守る主張:
 * 1. 空きが少ない段(warn / alarm)だけ「注意」で積まれる。ok・読めない端末は積まない
 * 2. 編集を断られた(別のタブが握っている)ときの文が、**実際に編集ボタンから state.error に
 *    載った物**のまま「注意」になる(binder → state.error → 種類 の通し)
 * 3. 対照群:本体と話せない断り・その他の失敗は「問題」のまま(「注意」へ広がらない)
 * 4. 積んだ先は既存の 1 本(`MessagePost`)── 同じノート・保管件数の決まり(処理の 5,000 件ではない)に乗る
 * 5. `main.ts` の 2 か所の配線(`main.ts` はどの test からも走らないので原文で pin する)
 *
 * ⚠ 守っていない物:`main.ts` の onState が本当に post を呼ぶ動き(原文 pin は弱い ──
 *   位置を保って挙動を壊す変異は通りうる。判断自体は `caution-events.ts` に寄せてある)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  MessagePost,
  type MessageSpool,
  type SpoolItem,
} from '../../src/adapter/platform/message-post';
import {
  EDIT_ELSEWHERE_ERROR,
  RESERVED_LOCK_CAUTION_TEXT,
  messageKindForOpError,
  quotaCaution,
  reservedLockCaution,
} from '../../src/features/message/caution-events';
import { BANNED_TERMS } from '../../src/features/ui-terms';
import {
  JOB_CAP,
  MESSAGE_CAP_DEFAULT,
  SYSTEM_MESSAGE_LID,
  countUnread,
} from '../../src/features/message/message-log';
import {
  QUOTA_ALARM_RATIO,
  QUOTA_WARN_RATIO,
  quotaBootNotice,
} from '../../src/features/storage/quota-watch';

class FakeSpool implements MessageSpool {
  async list(): Promise<ReadonlyArray<{ id: number; item: SpoolItem }>> {
    return [];
  }
  async push(): Promise<void> {}
  async remove(): Promise<void> {}
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const Q = 100 * 1024 * 1024;
const at = (ratio: number): { usage: number; quota: number } => ({ usage: Q * ratio, quota: Q });

describe('保存先の空きが少ない → 「注意」', () => {
  it('warn / alarm の段だけ積む(画面下の 1 行と同じ字)', () => {
    for (const ratio of [QUOTA_WARN_RATIO, QUOTA_ALARM_RATIO]) {
      const c = quotaCaution(at(ratio));
      expect(c, `${ratio}`).not.toBeNull();
      expect(c?.kind).toBe('caution');
      expect(c?.text).toBe(quotaBootNotice(at(ratio)));
      expect(c?.text.length).toBeGreaterThan(20); // 空文字に満たされない
    }
  });

  it('対照群:余裕がある / 読めない端末は積まない(嘘の警告を作らない)', () => {
    expect(quotaCaution(at(0.1))).toBeNull();
    expect(quotaCaution({})).toBeNull();
    expect(quotaCaution({ usage: 5, quota: 0 })).toBeNull();
  });

  it('🔴 積むと、sys-messages へ「注意」の節で入り、未読に数えられる', async () => {
    const post = new MessagePost(new FakeSpool());
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    const unread: number[] = [];
    post.onUnreadChanged((n) => unread.push(n));
    const c = quotaCaution(at(QUOTA_ALARM_RATIO));
    expect(c).not.toBeNull();
    post.post(c!);
    await flush();
    const req = appendMessage.mock.calls[0]?.[0] as { lid: string; section: string; cap: number };
    expect(req.lid).toBe(SYSTEM_MESSAGE_LID);
    expect(req.section).toContain('**注意** quota');
    expect(req.section).not.toContain('**問題**');
    // 保管件数の決まりに乗る(user の選んだ上限。処理の 5,000 件ではない)
    expect(req.cap).toBe(MESSAGE_CAP_DEFAULT);
    expect(req.cap).not.toBe(JOB_CAP);
    expect(countUnread(req.section, null)).toBe(1);
    expect(unread).toEqual([1]);
  });
});

describe('書込の途中で閉じても元へ戻す仕組みが働いていない → 「注意」(#1218 F1)', () => {
  const OPFS = 'opfs-sahpool' as const;

  it('OPFS で開けて、差し替えも当たらず、上流も直っていない回だけ積む', () => {
    const c = reservedLockCaution({
      vfs: OPFS,
      reservedLockPatched: false,
      reservedLockUpstreamFixed: false,
    });
    expect(c?.kind).toBe('caution');
    expect(c?.text).toBe(RESERVED_LOCK_CAUTION_TEXT);
    expect(c?.text.length).toBeGreaterThan(20);
  });

  it('対照群:差し替えが当たった / 上流が直った / :memory: の回は黙る(嘘の警告を積まない)', () => {
    const base = { reservedLockPatched: false, reservedLockUpstreamFixed: false };
    expect(reservedLockCaution({ vfs: OPFS, ...base, reservedLockPatched: true })).toBeNull();
    expect(reservedLockCaution({ vfs: OPFS, ...base, reservedLockUpstreamFixed: true })).toBeNull();
    expect(reservedLockCaution({ vfs: 'memory', ...base })).toBeNull();
  });

  it('字は「使わない語」(ui-terms)を含まない', () => {
    for (const t of BANNED_TERMS) {
      expect(RESERVED_LOCK_CAUTION_TEXT, t.banned).not.toMatch(t.pattern());
    }
  });
});

describe('別のタブが同じノートを編集中 → 「注意」(binder から通しで)', () => {
  const meta = (lid: string): EntryMeta => ({
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  });
  const tick = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 10));
  };

  async function pressEdit(
    grant: 'granted' | 'denied' | 'unreachable',
  ): Promise<string | null> {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => detail.render(s));
    bindActions(root, d, { acquireEditLock: async () => grant });
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '# 本文',
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    await tick();
    return d.getState().error;
  }

  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

  it('🔴 断られた文は正本の字そのままで、種類は「注意」', async () => {
    const error = await pressEdit('denied');
    expect(error).toBe(EDIT_ELSEWHERE_ERROR);
    expect(messageKindForOpError(error as string)).toBe('caution');
  });

  it('対照群:本体と話せない断りは「問題」のまま(「注意」へ広げない)', async () => {
    const error = await pressEdit('unreachable');
    expect(error).toContain('最初に開いた PKC のタブと通信できません');
    expect(messageKindForOpError(error as string)).toBe('problem');
  });

  it('対照群:他の失敗文(例外の文・空文字)も「問題」', () => {
    expect(messageKindForOpError('保存に失敗しました')).toBe('problem');
    expect(messageKindForOpError('')).toBe('problem');
    // 近い文(前後に何か付いた)も「注意」にしない ── 完全一致だけ
    expect(messageKindForOpError(EDIT_ELSEWHERE_ERROR + '。')).toBe('problem');
  });

  it('積むと sys-messages へ「注意」の節になる', async () => {
    const post = new MessagePost(new FakeSpool());
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    post.attach({ cid: 'c1', appendMessage });
    post.post({
      kind: messageKindForOpError(EDIT_ELSEWHERE_ERROR),
      source: 'app',
      text: EDIT_ELSEWHERE_ERROR,
    });
    await flush();
    const req = appendMessage.mock.calls[0]?.[0] as { section: string; lid: string };
    expect(req.lid).toBe(SYSTEM_MESSAGE_LID);
    expect(req.section).toContain('**注意** app');
    // 文の括弧(…)は「…」ではないので潰されない(読める形で残る)
    expect(req.section).toContain('別のタブかウィンドウで編集中です');
  });
});

describe('配線の原文 pin(main.ts / binder.ts)', () => {
  const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));
  const binder = codeOnly(readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8'));

  it('main.ts: OP_FAILED の種類を文で決め、固定の「問題」を書かない', () => {
    expect(main).toContain('kind: messageKindForOpError(state.error)');
    expect(main).not.toMatch(/kind:\s*'problem',\s*source:\s*'app',\s*text:\s*state\.error/);
  });

  it('main.ts: 空きが少ないとき、メッセージへ積み、画面下の 1 行も今までどおり出す', () => {
    expect(main).toContain('const caution = quotaCaution(est);');
    expect(main).toContain('appMessagePost.post(caution);');
    expect(main).toContain('showStatus(caution.text);');
  });

  it('main.ts: 書込の途中の巻き戻しが働いていないとき、本体のタブだけが積み、画面下の 1 行も出す(#1218)', () => {
    expect(main).toMatch(/if \(followerConn === null\) \{\s*const lockCaution = reservedLockCaution\(init\);/);
    expect(main).toMatch(
      /if \(lockCaution !== null\) \{\s*appMessagePost\.post\(lockCaution\);\s*showStatus\(lockCaution\.text\);/,
    );
  });

  it('binder.ts: 断り文は正本の定数から出し、字を 2 か所に書かない', () => {
    expect(binder).toContain('? EDIT_ELSEWHERE_ERROR');
    expect(binder).not.toContain('別のタブかウィンドウで編集中です');
  });
});
