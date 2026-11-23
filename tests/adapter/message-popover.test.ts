/** @vitest-environment happy-dom */
/**
 * 🔴 **メッセージの入口と簡易履歴(ポップオーバー)**(2026-11-23。画面いちばん下の常設の帯の代わり)。
 * 観測点は DOM(`aria-expanded` / `hidden` / 入口のバッジ / 受け手へ届いた action)。時計は fake timers で進める。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import {
  entryBadge,
  entryLabel,
  HOVER_CLOSE_GRACE_MS,
  HOVER_OPEN_DELAY_MS,
  installMessagePopover,
  messagePopoverController,
  paintMessagePopover,
  shortTime,
  type MessageStatusModel,
} from '../../src/adapter/ui/render/message-entry';
import { SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';
import { appMessagePost } from '../../src/adapter/platform/message-post';
import { collectionBarItems } from '../../src/adapter/ui/render/collection-bar';
import { paintRail } from '../../src/adapter/ui/render/rail';

const M0: MessageStatusModel = { unread: 0, state: [], captureRecovery: 0, detail: '' };
const withUnread = (n: number): MessageStatusModel => ({ ...M0, unread: n });

const made: Array<{ dispose(): void }> = [];

function setup(opts: { hover?: boolean; recent?: () => readonly { at: string; kind: 'result' | 'caution' | 'problem' | 'delivery' | 'job'; text: string }[] } = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  const ctrl = installMessagePopover(root, { hoverCapable: () => opts.hover ?? true, recent: opts.recent ?? (() => []) });
  made.push(ctrl);
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  paintRail(shell, false);
  const entry = shell.querySelector<HTMLElement>('[data-pkc-region="rail"] [data-pkc-field="message-entry"]')!;
  const pop = regions.messagePopover;
  return { root, regions, d, sent, ctrl, entry, pop, shell };
}

function pointer(type: string, target: Element, related: Element | null = null, pointerType = 'mouse'): void {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  Object.defineProperty(e, 'relatedTarget', { value: related });
  target.dispatchEvent(e);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // 🔴 前のテストの聞き手(document の Esc / 外押し)を残さない ── 開いたまま残った古い簡易履歴が Esc を飲む
  for (const c of made.splice(0)) c.dispose();
  vi.useRealTimers();
  document.body.textContent = '';
});

describe('入口(登記と配置)', () => {
  it('🔴 左のバーの一番下の群に入口が在り、登記は collectionBarItems() の 1 件だけ', () => {
    const items = collectionBarItems().filter((i) => i.action === 'toggle-message-popover');
    expect(items).toHaveLength(1);
    expect(items[0]!.group).toBe('app');
    // 群の中で最後(縦のバーの一番下)
    const apps = collectionBarItems().filter((i) => i.group === 'app');
    expect(apps[apps.length - 1]!.action).toBe('toggle-message-popover');
  });

  it('🔴 PC 幅では縦のバーの中の入口、スマホ幅では上の帯の入口(phone-bar)が在り、どちらも同じ受け手を指す', () => {
    const { shell } = setup();
    const rail = shell.querySelector('[data-pkc-region="rail"] [data-pkc-field="message-entry"]');
    expect(rail, 'バーに入口が無い').not.toBeNull();
    const phone = shell.querySelector('[data-pkc-region="phone-bar"] [data-pkc-field="message-entry"]');
    expect(phone, 'スマホの帯に入口が無い').not.toBeNull();
    expect(phone!.getAttribute('data-pkc-action')).toBe('toggle-message-popover');
    expect(rail!.getAttribute('data-pkc-action')).toBe('toggle-message-popover');
    for (const e of [rail!, phone!]) {
      expect(e.getAttribute('aria-haspopup')).toBe('dialog');
      expect(e.getAttribute('aria-expanded')).toBe('false');
    }
    // 🔴 phone 切替でも入口は届く位置に残る: 同じボタンが「作る」の行の末尾へ移り(コレクションの列の 8 個は 1 行のまま)、PC の幅で元へ戻る
    paintRail(shell, true);
    expect(shell.querySelectorAll('[data-pkc-field="message-entry"]')).toHaveLength(2);
    expect(shell.querySelector('[data-pkc-region="create-bar"] [data-pkc-field="message-entry"]'), 'スマホ幅で作る行へ移っていない').toBe(rail);
    expect(shell.querySelector('[data-pkc-region="collection-bar"] [data-pkc-field="message-entry"]'), 'コレクションの列に残っている(8 個 1 行が崩れる)').toBeNull();
    paintRail(shell, false);
    expect(shell.querySelector('[data-pkc-region="rail"] [data-pkc-region="collection-bar"] [data-pkc-field="collection-app-group"] > [data-pkc-field="message-entry"]'), 'PC の幅で元の場所へ戻らない').toBe(rail);
    expect(shell.querySelectorAll('[data-pkc-field="message-entry"]')).toHaveLength(2);
  });
});

describe('バッジと説明(いまの状態の言葉を含む)', () => {
  it('未読 0 なら出ない / 未読があれば数 / 99 超は 99+ / 実害の警告は !(危険色)', () => {
    expect(entryBadge(M0)).toEqual({ text: '', tone: 'none' });
    expect(entryBadge(withUnread(3))).toEqual({ text: '3', tone: 'warn' });
    expect(entryBadge(withUnread(120)).text).toBe('99+');
    const severe: MessageStatusModel = { ...M0, state: [{ kind: 'storage', text: '⚠ 保存領域が使えません', severe: true }] };
    expect(entryBadge(severe)).toEqual({ text: '!', tone: 'danger' });
    // 🔴 実害の警告は、未読があっても赤い「!」を譲らない(数は説明に入る)
    expect(entryBadge({ ...severe, unread: 2 })).toEqual({ text: '!', tone: 'danger' });
    expect(entryLabel({ ...severe, unread: 2 })).toContain('未読 2 件');
    expect(entryBadge({ ...M0, captureRecovery: 1 })).toEqual({ text: '!', tone: 'info' });
  });

  it('🔴 説明(aria-label / title)に、編集中・保存先の注意・複数タブ・同期・保存中の言葉が入る', () => {
    const m: MessageStatusModel = {
      unread: 2,
      captureRecovery: 0,
      detail: '',
      state: [
        { kind: 'editing', text: '編集中', severe: false, phase: 'editing' },
        { kind: 'storage', text: '保存先の注意', severe: false },
        { kind: 'sync', text: '複数タブ: x', severe: false },
        { kind: 'folder-sync', text: '同期しています…', severe: false },
        { kind: 'saving', text: '⏳ 保存中…', severe: false },
      ],
    };
    const { ctrl, entry } = setup();
    ctrl.setModel(m);
    const label = entry.getAttribute('aria-label')!;
    for (const w of ['未読 2 件', '編集中', '保存先の注意', '複数タブ', '同期しています', '保存中']) expect(label, w).toContain(w);
    expect(entry.getAttribute('title') ?? entry.getAttribute('data-pkc-tip-title')).toContain('編集中');
    expect(entry.hasAttribute('data-pkc-saving-dot'), '保存中の点').toBe(true);
    ctrl.setModel(M0);
    expect(entry.hasAttribute('data-pkc-saving-dot')).toBe(false);
    expect(entry.getAttribute('aria-label')).toBe('メッセージ');
  });
});

describe('開き方: クリック(固定)', () => {
  it('🔴 クリックで開き(aria-expanded)、もう一度で閉じ、閉じると焦点が入口へ戻る', () => {
    const { entry, pop, ctrl } = setup();
    expect(pop.hidden).toBe(true);
    entry.click();
    expect(ctrl.isOpen()).toBe(true);
    expect(pop.hidden).toBe(false);
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    expect(pop.contains(document.activeElement) || document.activeElement === pop, '開いたら焦点が中へ').toBe(true);
    entry.click();
    expect(ctrl.isOpen()).toBe(false);
    expect(pop.hidden).toBe(true);
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(entry);
  });

  it('🔴 Esc で閉じ、焦点は入口へ戻り、Esc は背後へ伝わらない(対照: 閉じているときの Esc は素通し)', () => {
    const { entry, ctrl } = setup();
    const seen: string[] = [];
    document.addEventListener('keydown', () => seen.push('bubbled'));
    entry.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ctrl.isOpen()).toBe(false);
    expect(document.activeElement).toBe(entry);
    expect(seen, 'Esc が背後へ伝わった').toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(seen, '対照: 閉じているときは素通し').toEqual(['bubbled']);
  });

  it('🔴 外を押すと閉じる(焦点は押した先のまま)/ 中を押しても閉じない', () => {
    const { entry, pop, ctrl, root } = setup();
    entry.click();
    pop.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(ctrl.isOpen(), '中を押して閉じた').toBe(true);
    const other = document.createElement('button');
    root.append(other);
    other.focus();
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(ctrl.isOpen()).toBe(false);
    expect(document.activeElement, '外を押したのに焦点を奪い返した').toBe(other);
  });

  it('🔴 × で閉じ、焦点は入口へ戻る', () => {
    const { entry, pop, ctrl } = setup();
    entry.click();
    pop.querySelector<HTMLElement>('[data-pkc-action="close-message-popover"]')!.click();
    expect(ctrl.isOpen()).toBe(false);
    expect(document.activeElement).toBe(entry);
  });

  it('入口が 2 つ在っても、押した方に付いて開く(aria-expanded は押した方だけ)', () => {
    const { shell, ctrl } = setup();
    shell.querySelector<HTMLElement>('[data-pkc-region="phone-bar"]')!.hidden = false;
    const phone = shell.querySelector<HTMLElement>('[data-pkc-region="phone-bar"] [data-pkc-field="message-entry"]')!;
    const rail = shell.querySelector<HTMLElement>('[data-pkc-region="rail"] [data-pkc-field="message-entry"]')!;
    phone.click();
    expect(phone.getAttribute('aria-expanded')).toBe('true');
    expect(rail.getAttribute('aria-expanded')).toBe('false');
    expect(ctrl.isOpen()).toBe(true);
  });
});

describe('開き方: ホバー(遅延・猶予・クリックで固定)', () => {
  it('🔴 載せて 0.3 秒たつまでは開かず、たつと開く(対照: 手前では閉じたまま)', () => {
    const { entry, ctrl } = setup();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS - 1);
    expect(ctrl.isOpen(), '遅延の前に開いた').toBe(false);
    vi.advanceTimersByTime(2);
    expect(ctrl.isOpen()).toBe(true);
  });

  it('🔴 遅延の間に離れたら開かない', () => {
    const { entry, ctrl } = setup();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(100);
    pointer('pointerout', entry, document.body);
    vi.advanceTimersByTime(1000);
    expect(ctrl.isOpen()).toBe(false);
  });

  it('🔴 離れると猶予ののちに閉じる / 猶予の間にポップオーバーへ移れば閉じない', () => {
    const { entry, pop, ctrl } = setup();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1);
    pointer('pointerout', entry, document.body);
    vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS - 10);
    expect(ctrl.isOpen(), '猶予の前に閉じた').toBe(true);
    pointer('pointerover', pop.querySelector('h3')!);
    vi.advanceTimersByTime(1000);
    expect(ctrl.isOpen(), 'ポップオーバーへ移ったのに閉じた').toBe(true);
    pointer('pointerout', pop.querySelector('h3')!, document.body);
    vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS + 1);
    expect(ctrl.isOpen()).toBe(false);
  });

  it('🔴 ホバーで開いたあとクリックすると固定され、離れても閉じない(もう一度押すと閉じる)', () => {
    const { entry, ctrl } = setup();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1);
    entry.click();
    expect(ctrl.isOpen(), 'クリックで閉じた(固定されない)').toBe(true);
    pointer('pointerout', entry, document.body);
    vi.advanceTimersByTime(5000);
    expect(ctrl.isOpen(), '固定したのに離れて閉じた').toBe(true);
    entry.click();
    expect(ctrl.isOpen()).toBe(false);
  });

  it('🔴 指の端末(hover が使えない / pointerType=touch)ではホバーで開かない', () => {
    const a = setup({ hover: false });
    pointer('pointerover', a.entry);
    vi.advanceTimersByTime(2000);
    expect(a.ctrl.isOpen()).toBe(false);
    const b = setup({ hover: true });
    pointer('pointerover', b.entry, null, 'touch');
    vi.advanceTimersByTime(2000);
    expect(b.ctrl.isOpen()).toBe(false);
  });

  it('ホバーで開いたとき、焦点は奪わない(本文の欄で打ち続けられる)', () => {
    const { entry, root } = setup();
    const ta = document.createElement('textarea');
    root.append(ta);
    ta.focus();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1);
    expect(document.activeElement).toBe(ta);
  });
});

describe('中身(いまの状態 / 最近のメッセージ / ボタン)', () => {
  it('🔴 最近のメッセージを新しい順に最大 8 件、種類・時刻・字つきで出す。空なら空の言葉', () => {
    const recent = Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-23 10:${String(10 + i)}:00`, kind: 'caution' as const, text: `m${String(i)}` }));
    const { pop, ctrl, entry } = setup({ recent: () => recent });
    ctrl.setModel(M0);
    entry.click();
    const items = pop.querySelectorAll('[data-pkc-field="popover-list"] > li');
    expect(items).toHaveLength(8);
    expect(items[0]!.querySelector('[data-pkc-field="msg-text"]')!.textContent).toBe('m0');
    expect(items[0]!.querySelector('[data-pkc-field="msg-kind"]')!.textContent).toBe('注意');
    expect(items[0]!.getAttribute('data-pkc-kind')).toBe('caution');
    // 一覧は読み上げ領域にしない
    expect(pop.querySelector('[aria-live]'), 'ポップオーバーに aria-live がある').toBeNull();
    const empty = setup({ recent: () => [] });
    empty.entry.click();
    expect(empty.pop.querySelector('[data-pkc-field="popover-empty"]')!.textContent).toBe('メッセージはまだありません');
  });

  it('🔴 「いまの状態」に状態の言葉・保存先の警告(危険色の器 + バックアップのボタン)が出る', () => {
    const { pop, ctrl, entry, regions } = setup();
    ctrl.setModel({
      unread: 0,
      captureRecovery: 0,
      detail: '版 — 保存先',
      state: [
        { kind: 'editing', text: '編集中', severe: false, phase: 'editing' },
        { kind: 'storage', text: '⚠ 保存領域が使えません', severe: true },
      ],
    });
    entry.click();
    expect(pop.querySelector('[data-pkc-field="status-state"]')!.textContent).toBe('編集中');
    expect(pop.querySelector('[data-pkc-field="status-warning"]')!.textContent).toBe('⚠ 保存領域が使えません');
    // 警告の隣のバックアップのボタンはポップオーバーの中に在る(帯が無いので移した)
    expect(pop.contains(regions.statusBackup)).toBe(true);
    expect(pop.contains(regions.statusCaptureRecovery)).toBe(true);
    expect(pop.querySelector('[data-pkc-field="popover-state"] > h3')!.getAttribute('title')).toBe('版 — 保存先');
  });

  it('🔴 既読にする: 開かずに未読を 0 にする(MESSAGES_UNREAD_SET 0 + 既読の時刻)/ MESSAGES_READ は撃たない / 簡易履歴は開いたまま', () => {
    const { pop, ctrl, entry, sent } = setup();
    const spy = vi.spyOn(appMessagePost, 'markRead').mockImplementation(() => undefined);
    ctrl.setModel(withUnread(3));
    entry.click();
    pop.querySelector<HTMLElement>('[data-pkc-action="mark-messages-read"]')!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ type: 'MESSAGES_UNREAD_SET', count: 0 });
    expect(sent.some((a) => a.type === 'MESSAGES_READ')).toBe(false);
    expect(ctrl.isOpen()).toBe(true);
    spy.mockRestore();
  });

  it('🔴 「詳細メッセージ画面を開く」は既存の open-messages(sys-messages)を 1 度だけ撃ち、簡易履歴は閉じる', () => {
    const { pop, ctrl, entry, sent } = setup();
    const spy = vi.spyOn(appMessagePost, 'markRead').mockImplementation(() => undefined);
    entry.click();
    const detail = pop.querySelector<HTMLElement>('[data-pkc-action="open-messages"]')!;
    expect(detail.getAttribute('data-pkc-message-lid')).toBe(SYSTEM_MESSAGE_LID);
    detail.click();
    expect(sent.filter((a) => a.type === 'MESSAGES_READ')).toEqual([{ type: 'MESSAGES_READ', lid: SYSTEM_MESSAGE_LID }]);
    expect(ctrl.isOpen()).toBe(false);
    spy.mockRestore();
  });

  it('時刻は今日なら HH:MM、それ以外は MM-DD HH:MM', () => {
    expect(shortTime('2026-11-23 09:05:11', '2026-11-23')).toBe('09:05');
    expect(shortTime('2026-11-22 23:59:00', '2026-11-23')).toBe('11-22 23:59');
  });

  it('paintMessagePopover は何度呼んでも件数が積み上がらない(描き直し)', () => {
    const { pop } = setup();
    const r = [{ at: '2026-11-23 10:00:00', kind: 'result' as const, text: 'a' }];
    paintMessagePopover(pop, M0, r);
    paintMessagePopover(pop, M0, r);
    expect(pop.querySelectorAll('[data-pkc-field="popover-list"] > li')).toHaveLength(1);
  });
});

describe('配線(受け手と登記)', () => {
  it('🔴 浮き札の × は dismiss-toast を持ち、押すと浮き札へ pkc-toast-dismiss の合図が届く(消せない知らせを作らない)', () => {
    const { regions } = setup();
    expect(regions.statusClose.getAttribute('data-pkc-action')).toBe('dismiss-toast');
    expect(regions.status.contains(regions.statusClose), '× が浮き札の中に無い').toBe(true);
    let got = 0;
    regions.status.addEventListener('pkc-toast-dismiss', () => (got += 1));
    regions.statusClose.click();
    expect(got).toBe(1);
  });

  it('🔴 MENU_OPENERS に入口が載っている(載せ忘れると、他の一覧との同じクリックの競合になる ── 原文 pin。弱い)', () => {
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');
    const list = /const MENU_OPENERS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(list, 'MENU_OPENERS の一覧が読めない').not.toBeNull();
    expect([...(list?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])).toContain('toggle-message-popover');
  });

  it('🔴 入口を押すと、開いていた右クリックのメニューは閉じる(重ねて出さない)', () => {
    const { root, entry, ctrl } = setup();
    const menu = document.createElement('div');
    menu.setAttribute('data-pkc-region', 'context-menu');
    root.append(menu);
    entry.click();
    expect(ctrl.isOpen()).toBe(true);
    expect(root.querySelector('[data-pkc-region="context-menu"]'), '右クリックのメニューが残っている').toBeNull();
  });

  it('🔴 ポップオーバー内の別の画面へ進む押し口(バックアップ・録音の復元)でも閉じる / 既読にするでは閉じない', () => {
    const { pop, entry, ctrl, regions } = setup();
    entry.click();
    regions.statusBackup.hidden = false;
    regions.statusBackup.click();
    expect(ctrl.isOpen(), 'バックアップを押しても簡易履歴が残った').toBe(false);
    entry.click();
    vi.spyOn(appMessagePost, 'markRead').mockImplementation(() => undefined);
    pop.querySelector<HTMLElement>('[data-pkc-action="mark-messages-read"]')!.click();
    expect(ctrl.isOpen()).toBe(true);
  });

  it('同じ状態を渡し直しても、開いている一覧を作り直さない(打鍵ごとの state 変化)', () => {
    const { pop, ctrl, entry } = setup({ recent: () => [{ at: '2026-11-23 10:00:00', kind: 'result', text: 'a' }] });
    ctrl.setModel(M0);
    entry.click();
    const li = pop.querySelector('[data-pkc-field="popover-list"] > li');
    ctrl.setModel({ ...M0 });
    expect(pop.querySelector('[data-pkc-field="popover-list"] > li'), '同じ状態で一覧が作り直された').toBe(li);
    ctrl.setModel(withUnread(1));
    expect(pop.querySelector('[data-pkc-field="popover-list"] > li'), '状態が変わったのに描き直されない').not.toBe(li);
  });
});

describe('main.ts の配線(原文 pin ── 弱い。`main.ts` はどの test からも実行されないため)', () => {
  const code = readFileSync('src/main.ts', 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  it('🔴 入口と簡易履歴を据え、最近のメッセージの変化・状態を渡している', () => {
    expect(code).toContain('installMessagePopover(root, { recent: () => appMessagePost.recent() })');
    expect(code).toContain('appMessagePost.onRecentChanged(() => messageEntry.refresh())');
    expect(code).toContain('messageEntry.setModel({');
    expect(code).toContain('unread: st.messagesUnread,');
    expect(code).toContain('state: model.state,');
  });
  it('🔴 浮き札の × の合図を受けて、知らせ(statusNotices.dismiss)・エラー・進行中を閉じる', () => {
    expect(code).toContain("regions.status.addEventListener('pkc-toast-dismiss'");
    expect(code).toContain('statusNotices?.dismiss();');
    expect(code).toContain('toastDismissal.dismiss({ errorLine, progressLine: progressLine() }, toastShown)');
    expect(code).toContain('toastDismissal.apply(rawParts)');
    expect(code).toContain('errorAutoHide.track(rawParts.errorLine)');
    expect(code).toContain('installToastLift(root)');
    expect(code).toContain('statusNotices?.hold(on)');
    expect(code).toContain("severeToastLine: statusBaseSevere ? statusBase : ''");
    expect(code).toContain("appMessagePost.post({ kind: 'caution', source: 'storage', text: statusBase })");
  });
  it('🔴 読み上げの領域へ知らせとエラーだけを書き、画面下の常設の行(statusBarWithFileDrag / paintStatusText)は戻っていない', () => {
    expect(code).toContain('paintStatusLive(regions.statusLive, model.live);');
    expect(code).not.toContain('statusBarWithFileDrag');
    expect(code).not.toContain('paintStatusText');
  });
});

describe('Esc の扱い(ホバーで開いただけなら飲まない)', () => {
  const esc = (): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e;
  };
  it('🔴 ホバーで開いて焦点が外にあるとき: 簡易履歴は閉じるが Esc は背後へ伝わる(編集の取り消し・ダイアログの Esc を妨げない)', () => {
    const { entry, ctrl, root } = setup();
    const ta = document.createElement('textarea');
    root.append(ta);
    ta.focus();
    const seen: string[] = [];
    const spy = (): number => seen.push('bubbled');
    document.addEventListener('keydown', spy);
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1);
    expect(ctrl.isOpen()).toBe(true);
    const e = esc();
    document.removeEventListener('keydown', spy);
    expect(ctrl.isOpen()).toBe(false);
    expect(seen, 'Esc を飲んだ').toEqual(['bubbled']);
    expect(e.defaultPrevented, 'Esc の既定を止めた').toBe(false);
  });
  it('🔴 クリックで固定したとき: Esc を使い切る(背後へ伝えない)', () => {
    const { entry, ctrl } = setup();
    const seen: string[] = [];
    const spy = (): number => seen.push('bubbled');
    document.addEventListener('keydown', spy);
    entry.click();
    const e = esc();
    document.removeEventListener('keydown', spy);
    expect(ctrl.isOpen()).toBe(false);
    expect(seen).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
  });
  it('🔴 ホバーで開いても焦点が簡易履歴の中に在るなら、Esc を使い切って焦点を入口へ戻す', () => {
    const { entry, pop, ctrl } = setup();
    pointer('pointerover', entry);
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 1);
    pop.querySelector<HTMLElement>('[data-pkc-action="mark-messages-read"]')!.focus();
    const seen: string[] = [];
    const spy = (): number => seen.push('bubbled');
    document.addEventListener('keydown', spy);
    esc();
    document.removeEventListener('keydown', spy);
    expect(ctrl.isOpen()).toBe(false);
    expect(seen).toEqual([]);
    expect(document.activeElement).toBe(entry);
  });
});

describe('入口の手掛かりと置き場', () => {
  it('🔴 複数タブ: 説明だけでなく info 色の点の印(data-pkc-multitab)が付き、無くなれば外れる', () => {
    const { ctrl, entry } = setup();
    ctrl.setModel({ ...M0, state: [{ kind: 'sync', text: '複数タブ: x', severe: false }] });
    expect(entry.hasAttribute('data-pkc-multitab')).toBe(true);
    ctrl.setModel(M0);
    expect(entry.hasAttribute('data-pkc-multitab')).toBe(false);
    const css = readFileSync('src/styles/app.css', 'utf8');
    expect(css).toMatch(/\[data-pkc-multitab\]::before\s*\{[^}]*var\(--info\)/);
  });
  it('🔴 押した入口が畳まれたら((スマホ ↔ PC の切替))簡易履歴は (0,0) へ置かず閉じる', () => {
    const { shell, ctrl } = setup();
    const phone = shell.querySelector<HTMLElement>('[data-pkc-region="phone-bar"] [data-pkc-field="message-entry"]')!;
    const bar = shell.querySelector<HTMLElement>('[data-pkc-region="phone-bar"]')!;
    bar.hidden = false;
    phone.click();
    expect(ctrl.isOpen()).toBe(true);
    bar.hidden = true;
    ctrl.setModel(withUnread(5));
    expect(ctrl.isOpen(), '見えない入口に付いて開いたまま').toBe(false);
  });
});

describe('実害の警告の浮き札', () => {
  it('🔴 浮き札に「バックアップを書き出す」(export-archive)があり、既定は畳まれている', () => {
    const { regions } = setup();
    expect(regions.statusBackupToast.getAttribute('data-pkc-action')).toBe('export-archive');
    expect(regions.status.contains(regions.statusBackupToast)).toBe(true);
    expect(regions.statusBackupToast.hidden).toBe(true);
  });
  it('🔴 CSS: 保存データの確認の押し口が出ている間は × を出さない(消えない知らせ)', () => {
    const css = readFileSync('src/styles/app.css', 'utf8');
    expect(css).toMatch(/status-rescue'\]:not\(\[hidden\]\)\) > \[data-pkc-field='status-close'\] \{\s*display: none;/);
  });
});

describe('据え付け', () => {
  it('同じ root に 2 度据えても古い方の聞き手は外れる(二重に開かない)', () => {
    const { root, entry } = setup();
    const again = installMessagePopover(root, { hoverCapable: () => true });
    expect(messagePopoverController(root)).toBe(again);
    entry.click();
    expect(again.isOpen()).toBe(true);
  });
});
