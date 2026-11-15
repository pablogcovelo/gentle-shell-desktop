// Run with pnpm dev:web already serving the renderer. No backend mutations.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const output = 'build/design-reference/screenshots';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const detailFailures = [];
const checkDetail = (check) => { try { check(); } catch (error) { detailFailures.push(error.message); } };
const selectors = {
  shell: ['.app', '.gc-app'], header: ['.topbar', '.gc-topbar'],
  rail: ['.rail', '.gc-rail'], sidebar: ['.sidebar', '.gc-chats'],
  contextbar: ['.contextbar', '.gc-conversation-header'],
  thread: ['.thread', '.gc-thread'], welcome: ['.welcome-hero', '.gc-welcome'],
  composer: ['.composer', '.gc-composer__box'], inspector: ['.inspector', '.gc-inspector'],
  footer: ['.footer', '.gc-footer'], gear: ['.rail-tools button:last-child', '.gc-rail__tools button:last-child'],
  gearIcon: ['.rail-tools button:last-child svg', '.gc-rail__tools button:last-child svg'],
};
try {
  for (const [width, height] of [[1440,900],[1200,900],[1100,900],[1000,780],[800,844],[520,844],[390,844],[320,844]]) {
    const geometry = {};
    for (const [index, name] of ['board', 'app'].entries()) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
      await page.goto(index ? 'http://127.0.0.1:5173/?firstRun=0' : pathToFileURL(`${process.cwd()}/design/slack-gentle/01-workspace.html`).href);
      await page.waitForTimeout(300);
      geometry[name] = {};
      for (const [region, pair] of Object.entries(selectors)) {
        const locator = page.locator(pair[index]).first();
        geometry[name][region] = await locator.count() ? await locator.evaluate(el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return { x:r.x, y:r.y, width:r.width, height:r.height, font:s.font, display:s.display };
        }) : null;
      }
      const arrow = await page.locator(index ? '.gc-composer__send svg' : '#composer .send svg').boundingBox();
      checkDetail(() => assert.deepEqual([arrow.width, arrow.height], [24, 24], `${name} send arrow at ${width}`));
      geometry[name].title = await page.locator(index ? '.gc-conversation-header__title-text' : '#workspace-title').boundingBox();
      if (width === 1440) geometry[name].folder = await page.locator(index ? '.gc-conversation-header__glyph' : '.contextbar h1 > svg').boundingBox();
      if (index) {
        const version = await page.evaluate(async () => {
          const { mockBridge } = await import('/shared/bridge/mockBridge.ts');
          return (await mockBridge.appInfo()).version;
        });
        const displayedVersion = await page.locator('.gc-footer__version').innerText();
        checkDetail(() => assert.equal(displayedVersion, `v${version.replace(/^v/, '')}`, `actual app version at ${width}`));
      }
      await page.screenshot({ path: `${output}/workspace-fidelity-${width}x${height}-${name}.png` });
      if (!index && [1440, 390].includes(width)) {
        await page.locator('.local-status').evaluate(el => el.remove());
        geometry[name].composerWithoutDisclaimer = await page.locator('.composer').boundingBox();
      }
      if (index) {
        assert.equal(await page.locator('.gc-footer').count(), 1);
        const footer = await page.locator('.gc-footer').boundingBox();
        assert.ok(footer && Math.abs(footer.y + footer.height - height) < 2, 'footer touches window bottom');
        if (width === 1440) {
          await page.getByRole('button', { name: 'Application settings', exact: true }).click();
          await page.getByRole('dialog').waitFor();
          await page.keyboard.press('Escape');
          await page.keyboard.press('Control+k');
          await page.getByRole('dialog').waitFor();
          await page.keyboard.press('Escape');
          for (const [hide, show, selector] of [
            ['Hide workspaces', 'Show workspaces', '.gc-chats'],
            ['Hide general information', 'Show general information', '.gc-inspector'],
          ]) {
            await page.getByRole('button', { name: hide, exact: true }).click();
            assert.equal(await page.locator(selector).isVisible(), false);
            await page.getByRole('button', { name: show, exact: true }).click();
            assert.equal(await page.locator(selector).isVisible(), true);
          }
          await page.locator('.gc-chat-list-item').first().click();
          await page.waitForTimeout(200);
          assert.notEqual(await page.locator('.gc-conversation-header').innerText(), 'New chat');
          await page.keyboard.press('Control+n');
          await page.waitForTimeout(200);
          assert.equal((await page.locator('.gc-conversation-header').innerText()).trim(), 'New chat');
          const input = page.locator('textarea');
          const before = await input.boundingBox();
          await input.fill(Array(12).fill('A multiline draft').join('\n'));
          assert.ok((await input.boundingBox()).height > before.height, 'composer autogrows');
          await input.fill('');
        }
        if (width === 390) {
          await page.getByRole('button', { name: 'Show workspaces', exact: true }).click();
          assert.equal(await page.locator('.gc-chats').isVisible(), true);
          await page.getByRole('button', { name: 'Application settings', exact: true }).click();
          await page.getByRole('dialog').waitFor();
          await page.keyboard.press('Escape');
        }
      }
      await page.close();
    }
    checkDetail(() => assert.ok(Math.abs(geometry.app.title.x - geometry.board.title.x) < 0.1, `context title x at ${width}: app ${geometry.app.title.x}, board ${geometry.board.title.x}`));
    if (width === 1440) checkDetail(() => assert.equal(geometry.app.folder.x, geometry.board.folder.x, 'folder stays aligned'));
    if ([1440, 390].includes(width)) {
      const offset = geometry.app.composer.y - geometry.board.composer.y;
      console.log(JSON.stringify({ width, composerOffset: offset, afterRemovingOnlyBoardDisclaimer: geometry.app.composer.y - geometry.board.composerWithoutDisclaimer.y }));
      checkDetail(() => assert.ok(Math.abs(geometry.app.composer.y - geometry.board.composerWithoutDisclaimer.y) < 1, `composer aligns without board disclaimer at ${width}`));
    }
    assert.equal(geometry.app.shell.font, geometry.board.shell.font, 'workspace typography matches board');
    assert.ok(Math.abs(geometry.app.composer.height - geometry.board.composer.height) < 1, 'empty composer box height matches board');
    for (const region of ['header', 'rail', 'sidebar', 'contextbar', 'welcome', 'footer', 'gear', 'gearIcon']) {
      for (const dimension of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(geometry.app[region][dimension] - geometry.board[region][dimension]) < 1, `${region} ${dimension} matches at ${width}`);
      }
    }
    console.log(JSON.stringify({ width, height, geometry }));
  }
  assert.deepEqual(errors, [], 'browser page errors');
  assert.deepEqual(detailFailures, [], 'targeted fidelity details');
} finally { await browser.close(); }
