/**
 * todo フレーバー: frontmatter(status / date / archived)+ 本文 markdown。
 * kanban のステータストグルは frontmatter 書換の構造化操作になる(P3-6)。
 */
import {
  parseFrontmatter,
  serializeFrontmatter,
  spliceFrontmatterKeys,
  type FrontmatterValue,
} from '../markdown/frontmatter';
import type { FlavorSpec } from './flavor-spec';

/**
 * かんばんトグル等の構造化操作: status だけを原文 splice で書き換える
 * (本文・他 key は byte 無傷 ── P3-4 review #5 の規律)。
 */
export function withTodoStatus(body: string, status: 'open' | 'done'): string {
  return spliceFrontmatterKeys(body, { status });
}

/** 抽出列 date の受理形。列は SQL の範囲検索に使うため厳密に YYYY-MM-DD のみ。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PKC2 todo-body.ts と同じ寛容 parse(不正 JSON = description 扱いで落とさない)。 */
function parsePkc2Todo(body: string): {
  status: 'open' | 'done';
  description: string;
  date?: string;
  archived?: boolean;
} {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    return {
      status: p.status === 'done' ? 'done' : 'open',
      description: typeof p.description === 'string' ? p.description : '',
      date: typeof p.date === 'string' && p.date !== '' ? p.date : undefined,
      archived: p.archived === true ? true : undefined,
    };
  } catch {
    return { status: 'open', description: body };
  }
}

export const todoFlavor: FlavorSpec = {
  archetype: 'todo',
  // 新規 todo は status を明示した frontmatter から始める(規約が最初から見える)
  seed: () => '---\nstatus: open\n---\n',
  extract(body) {
    const { meta } = parseFrontmatter(body);
    return {
      // 'done' 以外はすべて 'open'(PKC2 parseTodoBody と同じ正規化)。
      // todo は常に status を持つ ── kanban が SQL だけで全 todo を引けること
      status: meta['status'] === 'done' ? 'done' : 'open',
      date:
        typeof meta['date'] === 'string' && DATE_RE.test(meta['date'])
          ? meta['date']
          : null,
      archived: meta['archived'] === true,
    };
  },
  fromPkc2(body) {
    const todo = parsePkc2Todo(body);
    const meta: Record<string, FrontmatterValue> = { status: todo.status };
    if (todo.date) meta['date'] = todo.date;
    if (todo.archived) meta['archived'] = true;
    const fm = serializeFrontmatter(meta);
    // setFrontmatter は description 先頭の `---` を frontmatter と誤認して
    // 置換しうるため使わない ── 前置合成なら description は無傷で残る
    return todo.description === '' ? fm : `${fm}\n${todo.description}`;
  },
};
