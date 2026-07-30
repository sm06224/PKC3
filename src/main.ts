import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';

/** P1 bootstrap shell: 配信・CI・PWA の土管が通っていることを示す最小描画。 */
export function renderBootCard(root: HTMLElement): void {
  root.textContent = '';
  const card = document.createElement('section');
  card.setAttribute('data-pkc-region', 'boot-card');
  const heading = document.createElement('h1');
  heading.textContent = 'PKC3';
  const build = document.createElement('p');
  build.setAttribute('data-pkc-field', 'build');
  build.textContent = `${APP_ID} v${APP_VERSION} (${BUILD_KIND}) — P1 bootstrap shell`;
  card.append(heading, build);
  root.append(card);
}

function bootstrap(): void {
  const root = document.querySelector<HTMLElement>('[data-pkc-slot="root"]');
  if (root) renderBootCard(root);

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // SW 不成立(file:// の可搬 HTML 等)でもアプリは動く
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
