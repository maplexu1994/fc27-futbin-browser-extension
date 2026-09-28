const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('popup actions all have matching elements', () => {
  const ids = [...popup.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  for (const id of new Set(ids)) assert.match(html, new RegExp(`id="${id}"`));
});

test('database batch capture is no longer wired into the monitor extension', () => {
  for (const key of ['fc27Cards', 'fc27Captures', 'fc27FutbinUrlsV2', 'fc27PendingSearch']) {
    assert.equal(popup.includes(key), false);
    assert.equal(content.includes(key), false);
  }
  for (const id of ['cardsFile', 'openNext', 'capture', 'exportCsv']) {
    assert.equal(html.includes(`id="${id}"`), false);
  }
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.futbin.com/27/player/*']);
});
