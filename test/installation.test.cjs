const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');

const slug = 'fix-my-mist';
const script = readFileSync(join(__dirname, '..', `${slug}.user.js`), 'utf8');
const version = script.match(/^\/\/ @version\s+(\S+)/m)[1];

function clanSite(origin, manager = 'Tampermonkey') {
  let listener;
  const replies = [];
  const page = {
    addEventListener(type, fn) { assert.equal(type, 'message'); listener = fn; },
    postMessage(data, target) { replies.push({ data, target }); }
  };
  const sandbox = {
    window: page, unsafeWindow: page, location: { origin },
    GM_info: { script: { version }, scriptHandler: manager }
  };
  runInNewContext(script, sandbox);
  const send = (data, source = page, senderOrigin = origin) => listener({ data, source, origin: senderOrigin });
  return { send, replies };
}

// В песочнице нет DOM, кеша и меню: запуск игровых правок на сайте уронит тест.
test('на сайте клана скрипт сообщает версию и не запускает игровую часть', () => {
  for (const origin of ['https://templars-clan.online', 'https://www.templars-clan.online', 'https://mist.dev.nether.pp.ua']) {
    assert.ok(script.includes(`// @match        ${origin}/*`));
    const { send, replies } = clanSite(origin);
    send({ type: 'mist-clan:check-extension', slug, requestId: 'first' });
    send({ type: 'mist-clan:check-extension', slug, requestId: 'after-navigation' });
    assert.equal(replies.length, 2);
    assert.equal(replies[0].data.version, version);
    assert.equal(replies[0].data.manager, 'Tampermonkey');
    assert.equal(replies[0].data.slug, slug);
    assert.equal(replies[0].data.type, 'mist-clan:extension-status');
    assert.equal(replies[1].data.requestId, 'after-navigation');
    assert.equal(replies[0].target, origin);
  }
});

test('скрипт игнорирует чужие окна, домены и некорректные запросы', () => {
  const { send, replies } = clanSite('https://templars-clan.online');
  const request = { type: 'mist-clan:check-extension', slug, requestId: 'test' };
  for (const data of [null, {}, 'test', { ...request, slug: 'other' },
    { ...request, type: 'mist-clan:extension-status' }, { ...request, requestId: 1 },
    { ...request, requestId: 'x'.repeat(65) }]) send(data);
  send(request, {});
  send(request, undefined, 'https://other.example');
  assert.equal(replies.length, 0);
});

test('название менеджера не привязано к Tampermonkey', () => {
  const { send, replies } = clanSite('https://templars-clan.online', 'Violentmonkey');
  send({ type: 'mist-clan:check-extension', slug, requestId: 'test' });
  assert.equal(replies[0].data.manager, 'Violentmonkey');
});
