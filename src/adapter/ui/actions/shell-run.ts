/**
 * コマンドシェルの**実行の段取り**(#274 / #241)。
 *
 * ## 🔑 ここは段取りだけ。実体は `ShellOps`(binder が既存の実体を渡す)
 *
 * 命令表(`features/shell/commands.ts`)は `ShellPlan` を返すだけで、副作用を持たない。ここは
 * `plan → 確認 → effects を順に実行 → 結果を出力へ書く` を担当し、実際の書き込み
 * (移す・コピー・ゴミ箱・追記・タグ・書き出し・SQL・操作の実行)は **`ShellOps` を通して既存の実体**を呼ぶ。
 * DOM を触らないので、偽の `ShellOps` で全部の枝を unit で見られる。
 *
 * ## 🔴 危ない命令
 *
 * `plan.confirm` があれば `ops.confirm` を通し、断られたら**何も実行しない**。実行前に履歴へは積む(打ち直せる)。
 */
import { expandBang } from '@features/shell/history';
import { planLine } from '@features/shell/commands';
import type { PlanOp } from '@features/structure/structure-plan';
import type { ShellEffect, ShellEnv, ShellTable } from '@features/shell/types';
import { shellBlockText, type ShellBlock, type ShellSession } from '../render/cmdshell';

export interface OperationOutcome {
  /** `ran` = 実行した / `many` = 候補が複数 / `none` = 当てはまる操作がない / `blocked` = 当てはまるがいま押せない */
  readonly kind: 'ran' | 'many' | 'none' | 'blocked';
  readonly text: string;
  readonly table?: ShellTable;
}

export interface SqlOutcome {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  readonly truncated: boolean;
  readonly ms: number;
  readonly error: string;
}

export interface SearchOutcome {
  readonly rows: readonly { readonly lid: string; readonly title: string; readonly snippet: string }[];
  readonly truncated: boolean;
  readonly error: string;
}

/** 実行の結果の文。`failed` は断り・失敗。 */
export interface OpResult {
  readonly text: string;
  readonly failed: boolean;
  /** 新しくできたノート(次の `#1` で引ける)。 */
  readonly lids?: readonly string[];
}

export interface ShellOps {
  /** いまの state から命令表の環境を作る。 */
  env(session: ShellSession): ShellEnv;
  /** `.` が指す対象が 2 ペインの焦点のペイン / 選んでいるノートかを含め、プロンプトの現在地の字。 */
  promptText(session: ShellSession): string;
  applyPlan(ops: readonly PlanOp[]): OpResult;
  create(title: string, body: string, parent: string | null): OpResult;
  append(lid: string, text: string): Promise<OpResult>;
  move(lids: readonly string[], to: string | null): OpResult;
  copy(lids: readonly string[], to: string | null): Promise<OpResult>;
  trash(lids: readonly string[]): Promise<OpResult>;
  tag(lids: readonly string[], tags: readonly string[], mode: 'add' | 'remove'): OpResult;
  exportNote(lid: string, format: 'md' | 'pdf'): OpResult;
  open(lid: string): OpResult;
  enter(scope: string | null): OpResult;
  select(lids: readonly string[], mode: 'set' | 'clear'): OpResult;
  runSql(sql: string): Promise<SqlOutcome>;
  search(query: string): Promise<SearchOutcome>;
  operation(query: string): Promise<OperationOutcome>;
  operations(query: string): OperationOutcome;
  askConfirm(message: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
}

const cell = (v: string | number | null): string => (v === null ? '' : String(v));

/** 1 行を実行する。出力は `session` の塊へ書く(非同期の結果は後から更新)。 */
export async function runShellLine(ops: ShellOps, session: ShellSession, raw: string): Promise<ShellBlock | null> {
  const typed = raw.trim();
  if (typed === '') return null;
  const bang = expandBang(typed, session.history);
  const line = bang.line.trim();
  const block = session.begin(`${ops.promptText(session)} ${line}`);
  if (bang.error !== null) {
    session.update(block, { lines: [bang.error], failed: true });
    return block;
  }
  const env = ops.env(session);
  const plan = planLine(line, env);
  if (plan.error !== undefined) {
    session.update(block, { lines: [plan.error], failed: true });
    return block;
  }
  // 履歴へ積むのは「命令として読めた行」だけ(打ち間違いで ↑ を汚さない)。`!3` は展開した行を積む
  session.remember(line);
  if (plan.cwd !== undefined) session.cwd = plan.cwd;
  if (plan.numbered !== undefined) session.last = [...plan.numbered];
  const hasEffects = plan.effects.length > 0;
  session.update(block, { lines: [...plan.lines], table: plan.table ?? null, pending: hasEffects });
  if (!hasEffects) return block;

  if (plan.confirm !== undefined && !(await ops.askConfirm(plan.confirm))) {
    session.update(block, { lines: [...block.lines, 'やめました(何も実行していません)'], pending: false });
    return block;
  }
  for (const effect of plan.effects) {
    await runEffect(ops, session, block, effect);
  }
  session.update(block, { pending: false });
  return block;
}

function note(session: ShellSession, block: ShellBlock, r: OpResult): void {
  if (r.text !== '') session.say(block, r.text, r.failed);
  else if (r.failed) session.update(block, { failed: true });
  if (r.lids !== undefined && r.lids.length > 0) session.last = [...r.lids];
}

async function runEffect(ops: ShellOps, session: ShellSession, block: ShellBlock, e: ShellEffect): Promise<void> {
  switch (e.type) {
    case 'plan':
      note(session, block, ops.applyPlan(e.ops));
      return;
    case 'create':
      note(session, block, ops.create(e.title, e.body, e.parent));
      return;
    case 'append':
      note(session, block, await ops.append(e.lid, e.text));
      return;
    case 'move':
      note(session, block, ops.move(e.lids, e.to));
      return;
    case 'copy':
      note(session, block, await ops.copy(e.lids, e.to));
      return;
    case 'trash':
      note(session, block, await ops.trash(e.lids));
      return;
    case 'tag':
      note(session, block, ops.tag(e.lids, e.tags, e.mode));
      return;
    case 'export':
      note(session, block, ops.exportNote(e.lid, e.format));
      return;
    case 'open':
      note(session, block, ops.open(e.lid));
      return;
    case 'enter':
      note(session, block, ops.enter(e.scope));
      return;
    case 'select':
      note(session, block, ops.select(e.lids, e.mode));
      return;
    case 'sql': {
      const r = await ops.runSql(e.sql);
      if (r.error !== '') {
        session.say(block, r.error, true);
        return;
      }
      const table: ShellTable = {
        columns: r.columns,
        rows: r.rows.map((row) => row.map(cell)),
        lids: r.rows.map(() => null),
      };
      const tail = `${String(r.rows.length)} 行(${String(r.ms)} ms)${r.truncated ? '。上限で打ち切りました' : ''}`;
      session.update(block, { lines: [...block.lines, tail], table });
      return;
    }
    case 'search': {
      const r = await ops.search(e.query);
      if (r.error !== '') {
        session.say(block, r.error, true);
        return;
      }
      if (r.rows.length === 0) {
        session.say(block, `「${e.query}」に当てはまるノートはありません`);
        session.last = [];
        return;
      }
      const table: ShellTable = {
        columns: ['#', '題名', '一致した部分'],
        rows: r.rows.map((row, i) => [String(i + 1), row.title, row.snippet.replace(/\s+/gu, ' ')]),
        lids: r.rows.map((row) => row.lid),
      };
      session.last = r.rows.map((row) => row.lid);
      session.update(block, {
        lines: [...block.lines, `${String(r.rows.length)} 件${r.truncated ? '(上限で打ち切りました)' : ''}`],
        table,
      });
      return;
    }
    case 'operation': {
      const r = await ops.operation(e.query);
      session.update(block, {
        lines: [...block.lines, r.text],
        ...(r.table === undefined ? {} : { table: r.table }),
        failed: block.failed || r.kind === 'none' || r.kind === 'blocked',
      });
      return;
    }
    case 'operations': {
      const r = ops.operations(e.query);
      session.update(block, { lines: [...block.lines, r.text], table: r.table ?? null });
      return;
    }
    case 'history': {
      const list = [...session.history].reverse();
      if (list.length === 0) {
        session.say(block, '履歴はまだありません');
        return;
      }
      const table: ShellTable = {
        columns: ['#', '命令'],
        rows: list.map((l, i) => [String(i + 1), l]),
        lids: list.map(() => null),
        recall: list,
      };
      session.update(block, { lines: [...block.lines, `${String(list.length)} 件(!番号 でもう一度、!! で直前)`], table });
      return;
    }
    case 'clear':
      session.clear();
      return;
    case 'copy-result': {
      // この命令自身の塊ではなく、直前の結果をコピーする
      const idx = session.blocks.indexOf(block);
      const prev = session.blocks
        .slice(0, Math.max(0, idx))
        .reverse()
        .find((b) => b.lines.length > 0 || b.table !== null);
      if (prev === undefined) {
        session.say(block, 'コピーする結果がありません', true);
        return;
      }
      const okCopied = await ops.copyText(shellBlockText(prev));
      session.say(block, okCopied ? '直前の結果をコピーしました' : 'コピーできませんでした(ブラウザに拒否されました)', !okCopied);
      return;
    }
  }
}
