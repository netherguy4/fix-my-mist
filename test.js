// Проверки набора: node test.js
// Скрипт исполняется в песочнице целиком, как его увидит Tampermonkey.
// Значения приезжают из песочницы vm: у них свои прототипы, поэтому
// сравнение нестрогое.
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const script = fs.readFileSync("fix-my-mist.user.js", "utf8");
assert.ok(script.startsWith("// ==UserScript=="), "шапка userscript должна быть первой строкой");
for (const tag of ["@version", "@updateURL", "@downloadURL", "@match"]) {
  assert.ok(script.includes(tag), `в шапке нет ${tag}`);
}

// Клиент игры в песочнице: MOD.pages рисует страницы, C.post отдаёт по
// двенадцать записей, C.run кладёт пакет в C.PR. rendered — экран уже нарисован
// родной пагинацией (так бывает, когда правка встала после первого рендера).
function game({ rendered = false, store, intf, settings = {} } = {}) {
  const timers = [];
  const delays = [];
  const ticks = [];
  const posted = [];
  const menu = [];
  const saved = Object.assign({ "fix-my-mist-pages-mult": "5" }, store, settings);
  const loader = { style: { display: "none" } };
  const serverPage = (n) => ({
    pages: { records: 3164, per_page: 12, pages: 264, page: n },
    links: {},
    items_list: Array.from({ length: 12 }, (_, i) => `item${n}.${i}`),
    // Справочник под список: свой на каждой странице, ключи — id.
    users: { [1000 + n]: `owner${n}` }
  });
  const sandbox = {
    JSON, Math, Number, Object, Array, String, Boolean, parseFloat, console,
    localStorage: {
      getItem: (key) => (key in saved ? saved[key] : null),
      setItem(key, value) { saved[key] = value; }
    },
    document: {
      addEventListener() {},
      createElement: () => ({}),
      documentElement: { appendChild() {} },
      getElementById: () => loader,
      querySelector: (sel) => (sel === ".page" && rendered ? {} : null)
    },
    location: { reload() {} },
    setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); },
    clearTimeout() {},
    setInterval: (fn) => ticks.push(fn),
    clearInterval() {},
    GM_registerMenuCommand: (label) => menu.push(label) && menu.length,
    timers, delays, ticks, posted, loader, menu, saved, serverPage,
    result: null
  };
  sandbox.window = sandbox;
  sandbox.unsafeWindow = sandbox;
  sandbox.MOD = {
    pages: (d) => `<span class="pages">${Array.from({ length: d.pages }, (_, i) =>
      `<span id="page_${i + 1}" class="page">${i + 1}</span>`).join("")}</span>`
  };
  sandbox.UI = { pages: function pagesCtrl() {} };
  sandbox.UI.pages.prototype = { setHandlers() {} };
  sandbox.C = {
    PR: { intf: intf || "stored", data: rendered ? serverPage(1) : null },
    paths: {},
    post(pname, data, isLocation, dontrun, cb) {
      posted.push(data.page);
      assert.equal(loader.style.display, "block", "лоадер висит, пока едут страницы блока");
      cb(JSON.stringify({ paths: {}, process: { data: serverPage(data.page) } }));
    },
    run(raw) {
      sandbox.C.PR.data = JSON.parse(raw).process.data;
    }
  };
  return sandbox;
}

const FLUSH = "for (let i = 0; i < 20 && timers.length; i++) timers.splice(0, timers.length).forEach((fn) => fn());";

// Обычный путь: страница блока пришла ответом сервера через C.run.
const byRun = game();
vm.runInNewContext(`
  ${script}
  C.run(JSON.stringify({ process: { data: serverPage(6) } }));
  ${FLUSH}
  const html = MOD.pages(C.PR.data.pages, 5, false, true);
  result = {
    posted: posted.slice(),
    items: C.PR.data.items_list.length,
    page: C.PR.data.pages.page,
    blockIds: (html.match(/id="page_(\\d+)"/g) || []).slice(0, 3),
    select: html.includes("alx-pages-mult"),
    users: Object.keys(C.PR.data.users)
  };
`, byRun);
assert.deepEqual(byRun.result.posted, [7, 8, 9, 10], "блок догружает только недостающие страницы");
assert.equal(byRun.result.items, 60, "страницы блока склеиваются в один список");
assert.equal(byRun.result.page, 6, "блок остаётся на своей первой странице");
assert.deepEqual(byRun.result.blockIds, ['id="page_1"', 'id="page_6"', 'id="page_11"'],
  "номер блока уходит на сервер как номер его первой страницы");
assert.ok(byRun.result.select, "селект множителя рисуется рядом с пагинацией");
assert.deepEqual(byRun.result.users, ["1006", "1007", "1008", "1009", "1010"],
  "справочники страниц тоже склеиваются, иначе чужие карточки рисуются с undefined");
assert.equal(byRun.loader.style.display, "none", "после сборки блока лоадер гасится");

// Правка встала после первого рендера: C.run по этому экрану уже не придёт.
const afterRender = game({ rendered: true });
vm.runInNewContext(`
  ${script}
  ${FLUSH}
  result = { posted: posted.slice(), items: C.PR.data.items_list.length };
`, afterRender);
assert.deepEqual(afterRender.result.posted, [2, 3, 4, 5], "уже нарисованный экран догружается без C.run");
assert.equal(afterRender.result.items, 60, "догон склеивает блок так же, как обычный путь");

// Множитель помнится на список: у аукциона свой, общая настройка — только
// значение по умолчанию для списков без своей.
const perList = game({
  rendered: true,
  intf: "auction",
  store: { "fix-my-mist-pages-mult:auction": "2" }
});
vm.runInNewContext(`
  ${script}
  ${FLUSH}
  result = { posted: posted.slice(), items: C.PR.data.items_list.length };
`, perList);
assert.deepEqual(perList.result.posted, [2], "у списка со своей настройкой блок в две страницы");
assert.equal(perList.result.items, 24, "общая настройка не перебивает настройку списка");

// Opt-out: выключенная правка не цепляется за клиент вовсе.
const off = game({ rendered: true, settings: { "fix-my-mist:pages": "off" } });
const nativePages = off.MOD.pages;
vm.runInNewContext(`
  ${script}
  ${FLUSH}
  result = { posted: posted.slice() };
`, off);
assert.deepEqual(off.result.posted, [], "выключенная правка не ходит за страницами");
assert.equal(off.MOD.pages, nativePages, "выключенная правка не подменяет MOD.pages");
assert.deepEqual(off.menu, [
  "✔ Бой не зависает · эксперимент",
  "✔ Маршрут не обрывается · эксперимент",
  "✔ Автоход без задержки · эксперимент",
  "✔ Связь не обрывается · эксперимент",
  "✔ Лог боя не съезжает · эксперимент",
  "✘ Длинные списки · эксперимент"
],
  "меню показывает состояние каждой правки");

// Маршрут ждёт только остаток до next_turn_ms, а не следующий секундный тик.
const route = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
route.C.sdate = 1499;
route.C.PR.next_turn_ms = 1500;
route.C.PR.start_time_diff = 1;
route.steps = 0;
route.C.stepHexTimerAdventure = () => { route.steps++; };
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  const early = { steps, startTimeDiff: C.PR.start_time_diff, delay: delays[0] };
  C.sdate = 1500;
  timers.shift()();
  const precise = steps;
  C.stepHexTimerAdventure({ diff: 0 });
  result = { early, precise, steps };
`, route);
assert.deepEqual(route.result.early, { steps: 0, startTimeDiff: 0, delay: 1 },
  "ранний нулевой тик ждёт только остаток до точного серверного времени");
assert.equal(route.result.precise, 1, "точный таймер сразу делает шаг");
assert.equal(route.result.steps, 1, "следующий секундный тик не дублирует запрос");

// Автоход использует точный date_next_step, не дожидаясь секундного C.clock.
const walk = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:adventure-route": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
walk.now = 1499;
walk.Date = class extends Date {
  constructor(value) { super(value === undefined ? walk.now : value); }
  static now() { return walk.now; }
};
walk.C.clockdiff = 0;
walk.C.sdate = new walk.Date(walk.now);
walk.C.PR = { intf: "worldMap", start_time_diff: 1, data: { coord: [1, 0], date_next_step: 2 } };
walk.worldMap = { coord: [0, 0], way: [[2, 0]] };
walk.steps = 0;
walk.C.stepHexTimer = (value) => {
  const diff = Math.max(0, value - Math.floor(+walk.C.sdate / 1000));
  if (diff === 0 && walk.C.PR.start_time_diff === 0) walk.steps++;
  walk.C.PR.start_time_diff = diff;
};
vm.runInNewContext(`
  ${script}
  C.stepHexTimer(C.PR.data.date_next_step, "#trip_time_out");
  const early = { steps, delay: delays[0] };
  now = 2000;
  timers.shift()();
  const precise = steps;
  C.stepHexTimer(C.PR.data.date_next_step, "#trip_time_out");
  result = { early, precise, steps };
`, walk);
assert.deepEqual(walk.result.early, { steps: 0, delay: 501 },
  "автоход ждёт только остаток до серверного date_next_step");
assert.equal(walk.result.precise, 1, "в разрешённый момент штатный автоход делает шаг");
assert.equal(walk.result.steps, 1, "следующий секундный тик не повторяет шаг");

// Разморозка боя: анимация, чей AnimationStart потерялся, всё равно
// завершается — иначе TaskWorker объекта навсегда остаётся заблокированным.
function battleGame(params) {
  const sandbox = game();
  const signal = () => {
    const listeners = [];
    return {
      listeners,
      add: (fn) => listeners.push(fn),
      addOnce: (fn) => listeners.push(fn),
      dispatch(...args) { sandbox.dispatched++; listeners.splice(0).forEach((fn) => fn(...args)); }
    };
  };
  sandbox.dispatched = 0;
  sandbox.stopped = 0;
  sandbox.TweenHexEngine = {
    CSSAnimate: {
      // Игра теряет завершение: play() ничего не диспатчит.
      Animation: function Animation() {}
    }
  };
  sandbox.TweenHexEngine.CSSAnimate.Animation.prototype = {
    play() {},
    stop() { sandbox.stopped++; }
  };
  sandbox.makeAnimation = () => {
    const proto = sandbox.TweenHexEngine.CSSAnimate.Animation.prototype;
    const anim = Object.create(proto);
    anim.params = params;
    anim.onComplete = signal();
    return anim;
  };
  return sandbox;
}

const lost = battleGame(["ca_attack", "0.6s", false, "steps(1)"]);
vm.runInNewContext(`
  ${script}
  const anim = makeAnimation();
  anim.play();
  ${FLUSH}
  ${FLUSH}
  result = { dispatched, stopped };
`, lost);
assert.equal(lost.result.dispatched, 1, "потерянное завершение анимации досылается ровно один раз");
assert.equal(lost.result.stopped, 1, "перед досылкой анимация гасится, иначе поздний AnimationEnd сработает вторым");

const looped = battleGame(["ca_walk", "0.4s", true, "steps(1)"]);
vm.runInNewContext(`
  ${script}
  const anim = makeAnimation();
  anim.play();
  ${FLUSH}
  result = { dispatched };
`, looped);
assert.equal(looped.result.dispatched, 0, "зациклённую ходьбу страховка не обрывает");

// Связь не обрывается: мёртвый сокет поднимает сторож, раз родной путь молчит.
const chat = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:adventure-route": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
chat.now = 1000;
chat.Date = { now: () => chat.now };
chat.reconnects = 0;
chat.closed = 0;
const chatConn = () => ({ readyState: 1, close() { chat.closed++; } });
chat.INTF = { CHAT: {
  socket: { conn: chatConn() },
  createSocket() { this.socket = { conn: chatConn() }; return this; },
  autoReconnect() { chat.reconnects++; this.createSocket(); }
} };
vm.runInNewContext(`
  ${script}
  const watch = ticks[0];
  const CHAT = INTF.CHAT;
  // Сокет умер ровно так, как его убивает съеденный реконнект самой игры.
  CHAT.socket.conn = false;
  watch();
  now += 3000;
  watch();
  const early = reconnects;
  now += 3000;
  watch();
  const late = reconnects;
  now += 10000;
  watch();
  watch();
  const alive = CHAT.socket.conn.readyState;
  // Игра при новом сокете теряет прежний: он остаётся открытым и шлёт дубли.
  const lost = CHAT.socket;
  CHAT.createSocket();
  result = { early, late, after: reconnects, alive, closed, lostConn: lost.conn };
`, chat);
assert.equal(chat.result.early, 0, "родному пути дают фору, сторож не лезет сразу");
assert.equal(chat.result.late, 1, "мёртвый сокет сторож поднимает сам");
assert.equal(chat.result.after, 1, "живой сокет второй раз не переподключают");
assert.equal(chat.result.alive, 1, "после сторожа сокет снова открыт");
assert.equal(chat.result.closed, 1, "потерянный сокет закрывается, иначе сообщения придут дважды");
assert.equal(chat.result.lostConn, false, "у потерянного сокета соединение снято");

console.log("fix-my-mist ok");
