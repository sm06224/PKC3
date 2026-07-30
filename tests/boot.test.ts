import { describe, expect, it } from 'vitest';
import { renderBootCard } from '../src/main';

describe('P1 boot shell', () => {
  it('renders the boot card into the given root', () => {
    const root = document.createElement('div');
    renderBootCard(root);
    const card = root.querySelector('[data-pkc-region="boot-card"]');
    expect(card).not.toBeNull();
    const build = card?.querySelector('[data-pkc-field="build"]')?.textContent ?? '';
    expect(build).toContain('pkc3 v3.0.0-dev');
  });

  it('is idempotent (re-render does not duplicate)', () => {
    const root = document.createElement('div');
    renderBootCard(root);
    renderBootCard(root);
    expect(root.querySelectorAll('[data-pkc-region="boot-card"]').length).toBe(1);
  });
});
