/**
 * 🔴 **「埋め込み先のページの AI」を許すページの一覧**の節(#1407)── 「許可」の h3 の中。
 *
 * PKC3 を別のページに組み込んだとき、そのページの AI が PKC3 の道具を使えるのは、ここに入れたページだけ。
 * 以前は開発者ツールで `localStorage` を書き換えるしか入れる手段が無かった。
 *
 * 🔑 入れる道は**ここだけ**(埋め込み先のページから「入れてほしい」と頼む道は作らない ── 許す相手を
 *   その相手自身が決められてはいけない)。外す道も同じ節に 1 行ずつ在る。
 * 🔑 **すぐ効く**:門(`agent-embed.ts` / `embed-bridge.ts`)は呼ぶたびに保存を読む。`main.ts` が
 *   `onChange` で登録を合わせ直す(外したページの飛んでいる依頼も畳む)。
 * ⚠ origin は `textContent` で出す(HTML にしない)。
 * ⚠ ブラウザに憶えた「常に許す」は、一覧から外しても**残る**(取り消しは隣の「ブラウザの AI に許したこと」)。
 */
import type { EmbedOriginsStore } from '@adapter/transport/embed-origins';
import { FLAG_EMBED } from '@features/flags';
import {
  EMBED_ORIGIN_SAVE_FAILED,
  embedOriginAddedText,
  embedOriginDuplicateText,
  parseEmbedOriginInput,
} from '@features/agent/embed-origin-input';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

/** 「フラグがオフ」の知らせ。🔑 フラグの画面の字(`FLAG_EMBED.summary`)をそのまま引く。 */
export function embedFlagOffText(): string {
  return `フラグ「${FLAG_EMBED.summary}」がオフの間は、この一覧は使われません。フラグの画面でオンにしてください(切り替えると自動で読み込み直します)。`;
}

export function createEmbedOriginsSection(
  store: EmbedOriginsStore,
  embedOn: () => boolean = () => true,
): SettingsSection {
  let flagLine: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let result: HTMLElement | null = null;

  const say = (text: string, ok: boolean): void => {
    if (result === null) return;
    result.textContent = text;
    result.setAttribute('data-pkc-state', ok ? 'ok' : 'error');
  };

  const render = (): void => {
    const ul = list;
    if (!ul) return;
    ul.textContent = '';
    const origins = store.list();
    if (origins.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'まだ許したページはありません';
      ul.append(li);
      return;
    }
    for (const origin of origins) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-embed-origin', origin);
      const name = document.createElement('span');
      name.setAttribute('data-pkc-field', 'embed-origin-name');
      name.textContent = origin;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-field', 'embed-origin-remove');
      btn.textContent = '一覧から外す';
      btn.addEventListener('click', () => {
        // 🔴 書けなかったときは「外した」と言わない(許したままである)
        if (!store.remove(origin)) {
          say(EMBED_ORIGIN_SAVE_FAILED, false);
          return;
        }
        say(`${origin} を一覧から外しました`, true);
        render();
      });
      li.append(name, btn);
      ul.append(li);
    }
  };

  return {
    id: 'embed-origins',
    group: 'permissions',
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-embed-origins');
      const h = document.createElement('h4');
      h.textContent = '埋め込み先のページの AI を許すページ';
      const note = buildSettingsNote(
        'PKC3 を埋め込んだページのうち、ここに入れたページの AI だけが使えます。',
      );
      const form = document.createElement('div');
      form.setAttribute('data-pkc-field', 'embed-origin-form');
      input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('data-pkc-field', 'embed-origin-input');
      input.setAttribute('aria-label', '許すページのアドレス');
      input.placeholder = 'https://example.com';
      const add = document.createElement('button');
      add.type = 'button';
      add.setAttribute('data-pkc-field', 'embed-origin-add');
      add.textContent = '追加';
      result = document.createElement('p');
      result.setAttribute('data-pkc-field', 'embed-origin-result');
      result.setAttribute('role', 'status');
      const submit = (): void => {
        const parsed = parseEmbedOriginInput(input?.value ?? '');
        if (!parsed.ok) {
          say(parsed.reason, false);
          return;
        }
        if (store.list().includes(parsed.origin)) {
          say(embedOriginDuplicateText(parsed.origin), false);
          return;
        }
        if (!store.add(parsed.origin)) {
          say(EMBED_ORIGIN_SAVE_FAILED, false);
          return;
        }
        const typed = input?.value ?? '';
        if (input) input.value = '';
        say(embedOriginAddedText(parsed.origin, parsed.trimmed, typed), true);
        render();
      };
      add.addEventListener('click', submit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          submit();
        }
      });
      form.append(input, add);
      list = document.createElement('ul');
      list.setAttribute('data-pkc-field', 'embed-origin-list');
      // 🔴 フラグがオフなら、一覧に入れても使われないと先に言う(`sync` のたびに読み直す)
      flagLine = document.createElement('p');
      flagLine.setAttribute('data-pkc-field', 'embed-origin-flag-off');
      wrap.append(h, note, flagLine, form, result, list);
      // 別のタブが書き換えたとき(`storage` event → `notifyExternal`)も一覧を追いつかせる
      store.onChange(() => render());
      return wrap;
    },
    /** ⚠ 毎回組み直す(`devtools` など画面の外で変わっても、次の描画で追いつく)。 */
    sync(): void {
      if (flagLine) {
        const off = !embedOn();
        flagLine.hidden = !off;
        flagLine.textContent = off ? embedFlagOffText() : '';
      }
      render();
    },
  };
}
