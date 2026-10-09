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
  const saved = Object.assign({ "fix-my-mist-pages-mult": "5", "fix-my-mist:swap-kits": "off" }, store, settings);
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
    jQuery: () => ({ ajaxSend() {}, ajaxComplete() {}, ajaxError() {} }),
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
    pack: { paths: {} },
    post(pname, data, isLocation, dontrun, cb) {
      posted.push(data.page);
      assert.equal(loader.style.display, "block", "лоадер висит, пока едут страницы блока");
      cb(JSON.stringify({ paths: {}, process: { data: serverPage(data.page) } }));
    },
    run(raw) {
      const pack = JSON.parse(raw);
      sandbox.C.lastpack = pack;
      // Как в игре: pack на каждый пакет клонируется, а paths переназначается
      // только когда пакет их принёс.
      sandbox.C.pack = { paths: Object.assign({}, sandbox.C.pack.paths, pack.paths) };
      if (pack.paths) sandbox.C.paths = sandbox.C.pack.paths;
      sandbox.C.PR.data = pack.process.data;
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

// Возврат из лавки приносит последнюю серверную страницу блока.
for (const records of [45, 48, 49]) {
  const market = game({ intf: "market", store: { "fix-my-mist-pages-mult": "2" } });
  market.serverPage = (n) => ({
    pages: { records, per_page: 12, pages: Math.ceil(records / 12), page: n },
    places: Array.from({ length: Math.min(12, records - (n - 1) * 12) }, (_, i) => (n - 1) * 12 + i),
    users: { [n]: `owner${n}` }
  });
  market.C.post = (pname, data, isLocation, dontrun, cb) => {
    market.posted.push(data.page);
    cb(JSON.stringify({ paths: {}, process: { data: market.serverPage(data.page) } }));
  };
  vm.runInNewContext(`
    ${script}
    C.run(JSON.stringify({ paths: {}, process: { data: serverPage(4) } }));
    const initialHTML = MOD.pages(C.PR.data.pages);
    ${FLUSH}
    result = { data: C.PR.data, initialHTML, html: MOD.pages(C.PR.data.pages) };
  `, market);
  assert.deepEqual(market.posted, [3, 4], "возврат восстанавливает весь второй блок");
  assert.equal(market.result.data.pages.page, 3);
  assert.deepEqual(market.result.data.places,
    Array.from({ length: Math.min(24, records - 24) }, (_, i) => 24 + i),
    "магазины остаются в исходном порядке без пропусков и дублей");
  assert.deepEqual(Object.keys(market.result.data.users), ["3", "4"]);
  assert.ok(market.result.initialHTML.includes("alx-pages-mult"), "селект виден и на неполной странице");
  assert.ok(market.result.html.includes("alx-pages-mult"));
}

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
  "✔ Таймеры не забивают очередь · эксперимент",
  "✔ Лог боя не съезжает · эксперимент",
  "✘ Длинные списки · эксперимент",
  "✔ Перевод из меню ника",
  "✘ Перестановка боевых комплектов · эксперимент"
],
  "меню показывает состояние каждой правки");

// Маршрут ждёт только остаток до next_turn_ms, а не следующий секундный тик.
const route = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:transfer-menu": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
route.now = 1499;
route.Date = class extends Date { static now() { return route.now; } };
route.C.sdate = 1499;
route.C.PR.next_turn_ms = 1500;
route.C.PR.start_time_diff = 1;
route.steps = 0;
// Родной шаг гасит маршрут, если сервер не подтвердил предыдущий.
route.C.stepHexTimerAdventure = () => { route.steps++; route.C.PR.adventure_way = []; };
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  const early = { steps, startTimeDiff: C.PR.start_time_diff, delay: delays[0] };
  now = 1500;
  C.sdate = 1500;
  timers.shift()();
  const precise = steps;
  C.stepHexTimerAdventure({ diff: 0 });
  C.stepHexTimerAdventure({ diff: 0 });
  C.stepHexTimerAdventure({ diff: 0 });
  const waited = steps;
  C.stepHexTimerAdventure({ diff: 0 });
  C.PR.adventure_way = [1, 2, 3];
  C.stepHexTimerAdventure({ diff: 0 });
  const timedOut = steps;
  // Ответ пришёл: next_turn_ms сменился, следующий тик снова родной.
  C.PR.next_turn_ms = 1400;
  C.stepHexTimerAdventure({ diff: 0 });
  C.run(JSON.stringify({ process: {
    qs: "dung=1&__path=adventure&__idlnk=adventure&__lnkprtn=abcdef",
    action: "move", action_success: false, next_turn_ms: 1400, exec_time: 0.12,
    map: { self: "m1", obj: { m1: [6, 4, "m1", 2] } }, adventure_way: [1, 2, 3], status: 0, mode: "adventure"
  } }));
  C.run(JSON.stringify({ process: { qs: "ctrl=Battle&a=refresh", action: "show" } }));
  result = { early, precise, waited, timedOut, steps,
    trace: JSON.parse(localStorage.getItem("fix-my-mist:trace")).map((row) => row.slice(1)),
    incidents: JSON.parse(localStorage.getItem("fix-my-mist:incidents")) };
`, route);
assert.deepEqual(route.result.early, { steps: 0, startTimeDiff: 0, delay: 1 },
  "ранний нулевой тик ждёт только остаток до точного серверного времени");
assert.equal(route.result.precise, 1, "точный таймер сразу делает шаг");
assert.equal(route.result.waited, 1, "пока ответа на шаг нет, секундные тики не стирают маршрут");
assert.equal(route.result.timedOut, 2, "без ответа пять секунд — тик снова родной, маршрут может погаснуть");
assert.equal(route.result.steps, 3, "после ответа родной тик работает как обычно");
assert.equal(route.result.incidents.length, 1, "обрыв маршрута заморожен один раз");
assert.equal(route.result.incidents[0].why, "timeout", "видно, на каком тике маршрут погас");
assert.ok(route.result.incidents[0].tail.length > 1, "в записи лежит хвост трассы");
assert.deepEqual(route.result.trace.filter((r) => r[0] === "adv<-"),
  [["adv<-", "move", false, 1400, "6,4", 3, 0, "adventure", 0.12]],
  "ответ хода пишется в трассу, чужие пакеты — нет");

for (const clockdiff of [-100, 100, 0, undefined]) {
  const staleClock = game({ settings: {
    "fix-my-mist:battle-unfreeze": "off",
    "fix-my-mist:world-map-speed": "off",
    "fix-my-mist:socket-reconnect": "off",
    "fix-my-mist:transfer-menu": "off",
    "fix-my-mist:battle-log-row": "off",
    "fix-my-mist:pages": "off"
  } });
  staleClock.Date = class extends Date { static now() { return 1300 - (clockdiff || 0); } };
  staleClock.C.clockdiff = clockdiff;
  staleClock.C.sdate = 500;
  staleClock.C.PR.next_turn_ms = 1500;
  staleClock.steps = 0;
  staleClock.C.stepHexTimerAdventure = () => { staleClock.steps++; };
  vm.runInNewContext(`
    ${script}
    C.stepHexTimerAdventure({ diff: 0 });
    const remaining = delays[0];
    C.PR.next_turn_ms = 1200;
    C.stepHexTimerAdventure({ diff: 0 });
    timers.shift()();
    result = { remaining, steps };
  `, staleClock);
  assert.deepEqual(staleClock.result, { remaining: 200, steps: 1 },
    "устаревший C.sdate не удлиняет паузу; готовый шаг идёт сразу, старый таймер отменяется");
}

// Ответ без движения завершает ожидание запроса и сразу повторяет шаг, когда
// сервер оставил next_turn_ms прежним. Иначе правка принимала уже полученный
// ответ за потерянный, а после первой починки всё ещё ждала секундного тика.
const rejected = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:transfer-menu": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
rejected.now = 1499;
rejected.Date = class extends Date { static now() { return rejected.now; } };
rejected.C.sdate = 1499;
rejected.C.PR.next_turn_ms = 1500;
rejected.C.PR.start_time_diff = 1;
rejected.C.PR.adventure_way = [1, 2, 3];
rejected.steps = 0;
rejected.C.stepHexTimerAdventure = () => { rejected.steps++; };
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  now = 1500;
  C.sdate = 1500;
  timers.shift()();
  C.run(JSON.stringify({ process: {
    qs: "dung=1&__path=adventure&__idlnk=adventure&__lnkprtn=abcdef",
    action: "show", action_success: false, next_turn_ms: 1500,
    adventure_way: [1, 2, 3]
  } }));
  const retryDelay = delays[1];
  timers.shift()();
  result = { steps, retryDelay };
`, rejected);
assert.deepEqual(rejected.result, { steps: 2, retryDelay: 0 },
  "после полученного отказа шаг повторяется сразу, без секундного тика");

// Если штатный тик выиграл гонку с нулевым таймером повтора, второй запрос не
// нужен: сервер получил бы два одинаковых шага.
const raced = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:transfer-menu": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
raced.now = 1499;
raced.Date = class extends Date { static now() { return raced.now; } };
raced.C.sdate = 1499;
raced.C.PR.next_turn_ms = 1500;
raced.C.PR.start_time_diff = 1;
raced.C.PR.adventure_way = [1, 2, 3];
raced.steps = 0;
raced.C.stepHexTimerAdventure = () => { raced.steps++; };
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  now = 1500;
  C.sdate = 1500;
  timers.shift()();
  C.run(JSON.stringify({ process: {
    qs: "dung=1&__path=adventure&__idlnk=adventure&__lnkprtn=abcdef",
    action: "show", action_success: false, next_turn_ms: 1500,
    adventure_way: [1, 2, 3]
  } }));
  C.stepHexTimerAdventure({ diff: 0 });
  timers.shift()();
  result = steps;
`, raced);
assert.equal(raced.result, 2,
  "немедленный повтор отменяется, когда штатный тик уже отправил шаг");

// Успешный ответ ещё не означает, что клиент успел применить новую позицию.
// Пока C.PR остаётся прежним, ближайший тик должен считаться дублем: родной
// обработчик на старой координате решает, что шаг не состоялся, и стирает путь.
const confirmed = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:world-map-speed": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:transfer-menu": "off",
  "fix-my-mist:battle-log-row": "off",
  "fix-my-mist:pages": "off"
} });
confirmed.now = 1499;
confirmed.Date = class extends Date { static now() { return confirmed.now; } };
confirmed.C.sdate = 1499;
confirmed.C.PR.next_turn_ms = 1500;
confirmed.C.PR.start_time_diff = 1;
confirmed.C.PR.adventure_way = [1, 2, 3];
confirmed.steps = 0;
confirmed.C.stepHexTimerAdventure = () => {
  confirmed.steps++;
  if (confirmed.steps > 1) confirmed.C.PR.adventure_way = [];
};
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  now = 1500;
  C.sdate = 1500;
  timers.shift()();
  C.run(JSON.stringify({ process: {
    qs: "dung=1&__path=adventure&__idlnk=adventure&__lnkprtn=abcdef",
    action: "show", action_success: true, next_turn_ms: 1700,
    adventure_way: [1, 2]
  } }));
  C.stepHexTimerAdventure({ diff: 0 });
  result = { steps, way: C.PR.adventure_way.slice() };
`, confirmed);
assert.deepEqual(confirmed.result, { steps: 1, way: [1, 2, 3] },
  "успешный ответ не отпускает дубль, пока клиент остаётся на старой позиции");

// Автоход использует точный date_next_step, не дожидаясь секундного C.clock.
const walk = game({ settings: {
  "fix-my-mist:battle-unfreeze": "off",
  "fix-my-mist:adventure-route": "off",
  "fix-my-mist:socket-reconnect": "off",
  "fix-my-mist:transfer-menu": "off",
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
chat.closeCallbacks = 0;
const chatConn = () => ({
  readyState: 1,
  onclose() { chat.closeCallbacks++; },
  close() { chat.closed++; this.onclose?.(); }
});
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
assert.equal(chat.closeCallbacks, 0, "закрытие заменённого сокета не запускает get_key и новое переподключение");

vm.runInNewContext(`{
  const CHAT = INTF.CHAT;
  const retired = CHAT.socket;
  const conn = retired.conn;
  const cancelled = [];
  clearTimeout = id => { cancelled.push(id); };
  retired.reconnectTimeout = 17;
  conn.reconnectTimeout = 18;
  retired.callbacks = { close: [() => { throw new Error("stale close"); }] };
  conn.onopen = conn.onmessage = () => { throw new Error("stale data"); };
  CHAT.createSocket();
  const current = CHAT.socket;
  const closeBefore = closeCallbacks;
  current.conn.close();
  result = {
    cancelled,
    callbacks: Object.keys(retired.callbacks),
    timer: retired.reconnectTimeout,
    handlers: [conn.onopen, conn.onmessage, conn.onclose],
    currentClose: closeCallbacks - closeBefore
  };
}
`, chat);
assert.deepEqual(chat.result.cancelled, [17, 18], "таймеры Socket и SockJS заменённого соединения отменены");
assert.deepEqual(chat.result.callbacks, [], "отложенные события старого сокета больше не вызывают клиент");
assert.equal(chat.result.timer, null);
assert.deepEqual(chat.result.handlers, [null, null, null]);
assert.equal(chat.result.currentClose, 1, "настоящий обрыв текущего соединения по-прежнему обрабатывается");

// Трасса токенов ссылок: отправка помечается тем, кто её сделал, а ответ на
// устаревший токен (без paths) — STALE.
const traced = game({ rendered: true });
vm.runInNewContext(script + FLUSH + `
  loader.style.display = "block";
  C.paths.inventory_stored = "ctrl=Char&__lnkprtn=6bdcb72f55&h=1";
  C.post("inventory_stored", { action: "use", page: 1 }, false, true, () => {});
  C.run(JSON.stringify({ process: { qs: "ctrl=Char&__lnkprtn=6bdcb72f55", data: serverPage(1) } }));
  C.run(JSON.stringify({ paths: { inventory_stored: "ctrl=Char&__lnkprtn=a62bf8dcfc" }, process: { qs: "ctrl=Char&__lnkprtn=6bdcb72f55", data: serverPage(1) } }));
  result = JSON.parse(localStorage.getItem("fix-my-mist:trace")).map((row) => row.slice(1));
`, traced);
assert.deepEqual(traced.result, [
  ["game->", "inventory_stored", "6bdcb7", '{"action":"use","page":1}'],
  ["game<-", "6bdcb7", "STALE"],
  ["game<-", "6bdcb7", "inventory_stored:a62bf8"]
], "трасса пишет отправку, устаревший ответ и свежий токен");

// Токены: ссылки у игры в C.paths и C.pack.paths; после пакета без paths они
// расходятся, и свежий токен от догрузки должен попасть в оба (в песочнице экран зовётся refresh) — иначе следующий
// пакет с paths (пуш о начатом предметом бое) вернёт игре потраченный.
const tok = (s) => (String(s || "").match(/__lnkprtn=(\w{6})/) || [])[1];
const two = game();
let issued = 0;
two.C.post = function (pname, data, isLocation, dontrun, cb) {
  two.posted.push(tok(two.C.paths[pname]));
  const next = "ctrl=Char&__idlnk=refresh&__lnkprtn=" + String(++issued).padStart(6, "0") + "ffff";
  cb(JSON.stringify({ paths: { refresh: next }, process: { data: two.serverPage(data.page) } }));
};
vm.runInNewContext(`
  ${script}
  C.run(JSON.stringify({ paths: { refresh: "ctrl=Char&__idlnk=refresh&__lnkprtn=aaaaaa00" }, process: { qs: "ctrl=Char&__idlnk=refresh&__lnkprtn=00000000", data: serverPage(6) } }));
  // Пришёл пакет без paths: C.pack — новый клон, C.paths — старый объект.
  C.pack = { paths: Object.assign({}, C.paths) };
  ${FLUSH}
  const afterPages = { paths: C.paths.refresh, pack: C.pack.paths.refresh };
  C.run(JSON.stringify({ paths: { battle: "b&__lnkprtn=222222" }, process: { qs: "ctrl=Location&a=refresh", data: serverPage(6) } }));
  const afterPush = C.paths.refresh;
  C.run(JSON.stringify({ paths: { refresh: "ctrl=Char&__idlnk=refresh&__lnkprtn=aaaaaa00" }, process: { qs: "rs&__path=rs", data: serverPage(6) } }));
  result = {
    posted: posted.slice(), afterPages, afterPush, afterStale: C.paths.refresh,
    trace: JSON.parse(localStorage.getItem("fix-my-mist:trace")).map((row) => row.slice(1)).filter((r) => r[0] === "revert")
  };
`, two);
assert.deepEqual(two.result.posted, ["aaaaaa", "000001", "000002", "000003"], "каждая догрузка уходит с токеном из предыдущего ответа");
assert.equal(tok(two.result.afterPages.paths), "000004", "свежий токен в C.paths");
assert.equal(tok(two.result.afterPages.pack), "000004", "и в C.pack.paths");
assert.equal(tok(two.result.afterPush), "000004", "пуш без ссылки рюкзака не возвращает потраченный токен");
assert.equal(tok(two.result.afterStale), "000004", "потраченный токен из пакета не затирает свежий");
assert.deepEqual(two.result.trace, [["revert", "rs&__path=rs", "refresh", "aaaaaa", "000004"]], "откат виден в трассе");

const refresh = game({ settings: { "fix-my-mist:pages": "off" } });
const ajax = {};
let now = 0;
refresh.Date = class extends Date { static now() { return now; } };
refresh.jQuery = () => ({
  ajaxSend(fn) { ajax.send = fn; },
  ajaxComplete(fn) { ajax.complete = fn; }
});
refresh.C.post = function (pname, data, isLocation, dontrun, cb) {
  const xhr = { status: 200 };
  refresh.posted.push({ pname, data, cb, xhr });
  ajax.send(null, xhr, { url: "/?ctrl=Location&a=refresh&__path=" + pname + "&h=test" });
  return this;
};
vm.runInNewContext(script, refresh);
for (let i = 0; i < 66; i++) {
  now += 1000;
  assert.equal(refresh.C.post("refresh"), refresh.C);
}
assert.equal(refresh.posted.length, 1, "таймер не копит refresh, даже если ответ задержан на минуту");
refresh.C.post("refresh", { page: 2 }, false, true, () => {});
assert.equal(refresh.posted.length, 2, "догрузка страницы с колбэком не подавляется");
ajax.complete(null, refresh.posted[1].xhr);
refresh.C.post("refresh");
assert.equal(refresh.posted.length, 2, "завершение другого refresh не снимает ожидание первого");
refresh.C.post("get_key");
ajax.complete(null, refresh.posted[2].xhr);
assert.equal(refresh.posted.length, 3, "другие запросы проходят и не снимают ожидание refresh");
const failed = refresh.posted[0].xhr;
failed.status = 423;
ajax.complete(null, failed);
refresh.C.post("refresh");
now += 4999;
refresh.C.post("refresh");
assert.equal(refresh.posted.length, 3, "после ошибки есть пауза перед повтором");
now++;
refresh.C.post("refresh");
assert.equal(refresh.posted.length, 4, "после паузы таймер повторяет запрос");
refresh.posted[3].xhr.status = 0;
ajax.complete(null, refresh.posted[3].xhr);
now += 5000;
refresh.C.post("refresh");
assert.equal(refresh.posted.length, 5, "повтор разрешён и после сетевой ошибки");
ajax.complete(null, refresh.posted[4].xhr);
refresh.C.post("refresh");
assert.equal(refresh.posted.length, 6, "успешный ответ освобождает обновление");

// «Перевод» в меню ника открывает окно перевода с номером счёта персонажа.
const transfer = game({ settings: { "fix-my-mist:pages": "off" } });
const dom = { item: null, value: null, menuOpen: false, windows: 0 };
// Цепочный фейк jQuery: каждый вызов пишет, что с ним сделали.
const jq = (sel) => {
  const node = {
    length: sel === "#context_menu" ? Number(dom.menuOpen) : 1,
    ajaxSend() {}, ajaxComplete() {}, bind() { return node; }, focus() { return node; },
    remove() { return node; }, find() { return node; }, setMenuPos() { return node; },
    click(fn) { node.onclick = fn; return node; },
    insertBefore() { dom.item = node; return node; },
    val(v) { if (sel === "#trsfr_to input") dom.value = v; return node; },
    html: sel
  };
  return node;
};
jq.parseJSON = JSON.parse;
transfer.jQuery = jq;
transfer.C.PL = { id: 1 };
transfer.C.post = (pname, data, isLocation, dontrun, cb) => cb(JSON.stringify({ process: { canvas: { data: {
  account: { transfer_balance: 2704, money: [0, 2704] } } } } }));
transfer.INTF = { contextMenu() { dom.menuOpen = true; } };
transfer.MOD = { windowTransferRealMoney() { dom.windows++; }, windowExchangeRealMoney() {} };
vm.runInNewContext(script, transfer);
transfer.INTF.contextMenu(1, "self", {});
assert.equal(dom.item, null, "на свой ник пункт не добавляется");
transfer.INTF.contextMenu(2580916, "ZloyPer4ik", {});
assert.ok(dom.item.html.includes("Перевод"), "в меню ника есть «Перевод»");
dom.item.onclick();
assert.equal(dom.windows, 1, "открывается окно перевода");
assert.equal(dom.value, 2580916, "номер счёта — id персонажа");

// Сервер сохраняет вещь в обоих комплектах, а вытесненную убирает в рюкзак.
// Лук снимает щит автоматически; HP обрезается при каждом уменьшении максимума.
// Замена показывает комплект, в который надета вещь; switch_kit меняет только вид.
// Родной C.post показывает лоадер, а C.run прячет его инлайн-стилем.
function kitsGame({ ranged = false, sharedLeft = false, twoHanded = false, withoutArrows = false, initial = 1 } = {}) {
  const settings = Object.fromEntries([
    "battle-unfreeze", "adventure-route", "world-map-speed", "socket-reconnect",
    "timer-refresh", "battle-log-row", "pages", "transfer-menu"
  ].map((id) => ["fix-my-mist:" + id, "off"]));
  settings["fix-my-mist:swap-kits"] = "on";
  const sandbox = game({ settings });
  const items = {
    bow: { id: "bow", tab: 1, type: 11, slot: ["sword"], hp: 13 },
    sword: { id: "sword", tab: 1, type: 6, slot: ["sword"], hp: 71 },
    dagger: { id: "dagger", tab: 1, type: 8, slot: ["shield"], hp: 7 },
    shield: { id: "shield", tab: 1, type: 9, slot: ["shield"], hp: 29 },
    armor: { id: "armor", tab: 1, slot: ["armor"], hp: 0 },
    arrows: { id: "arrows", tab: 4, slot: ["quiver"], info: { total_quantity: 30 } }
  };
  if (twoHanded) items.sword.slot.push("shield");
  const kits = ranged
    ? { 1: { sword: "bow", shield: "dagger" }, 2: { sword: "sword", shield: "shield" } }
    : { 1: { sword: "sword", shield: "shield" }, 2: { sword: "bow", shield: "dagger" } };
  if (sharedLeft) kits[1].shield = kits[2].shield = "dagger";
  let quiver = !withoutArrows;
  let view = initial;
  const maxHP = () => 1000 + Object.values(kits[1]).reduce((hp, id) => hp + (items[id]?.hp || 0), 0);
  const data = () => {
    const alternative_list = {};
    const used = new Set(["armor", ...(quiver ? ["arrows"] : [])]);
    for (const kit of [1, 2]) {
      for (const id of Object.values(kits[kit])) {
        if (id) { used.add(id); alternative_list[id + "|" + kit] = kit; }
      }
    }
    return { kit: view, can_set: true, is_alt_kit_allowed: true,
      items_list: [...used].map((id) => id === "arrows"
        ? { ...items[id], info: { total_quantity: kits[view].sword === "bow" ? 30 : 0 } } : items[id]), alternative_list };
  };
  const dom = { button: null, count: 0 };
  const timeouts = new Map();
  const requests = [];
  const messages = [];
  let timer = 0;
  let pending;
  const classes = new Set();
  const listeners = [];
  let css = "";
  sandbox.document.documentElement = {
    classList: { toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); return force; } },
    appendChild: (node) => { css += node.textContent; }
  };
  sandbox.document.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  const loaderShown = () => sandbox.loader.style.display !== "none" || (classes.has("fmm-swapping-kits")
    && /html\.fmm-swapping-kits #loading_wnd \{[^}]*display:block!important/.test(css));
  // true — событие не дошло до игры.
  const blocked = (type) => {
    const event = { prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const l of listeners) if (l.type === type && l.capture === true) l.fn(event);
    return event.prevented && event.stopped;
  };
  const idle = () => {
    assert.equal(classes.has("fmm-swapping-kits"), false, "класс снят после окончания");
    assert.equal(sandbox.loader.style.display, "none", "родной лоадер спрятан");
    for (const type of ["click", "keydown", "keyup"]) assert.equal(blocked(type), false, "ввод снова доходит до игры");
  };
  const held = () => {
    assert.ok(loaderShown(), "лоадер держится всю перестановку");
    for (const type of ["click", "keydown", "keyup"]) assert.equal(blocked(type), true, "ввод в игру заблокирован");
  };
  sandbox.setTimeout = (fn, ms) => { timeouts.set(++timer, { fn, ms }); return timer; };
  sandbox.clearTimeout = (id) => timeouts.delete(id);
  sandbox.document.querySelector = (selector) => selector === ".set_control" ? {} : dom.button;
  sandbox.UI.DOM = (params) => {
    assert.equal(params.ctrl, "button", "кнопка использует родной контрол игры");
    assert.equal(dom.button, null, "на экране нет дубликата кнопки");
    dom.count++;
    dom.button = { click: params.handlers.click, disabled: false };
  };
  sandbox.INTF = { message: (message) => messages.push(message) };
  sandbox.C.PR = { intf: "stuff", data: data() };
  sandbox.C.PL = { health: maxHP(), health_max: maxHP() };
  sandbox.C.paths = { inventory_used: "token:0", switch_kit: "token:0" };
  sandbox.C.run = (raw) => {
    const pack = JSON.parse(raw);
    sandbox.loader.style.display = "none";
    sandbox.C.paths = pack.paths;
    sandbox.C.PR.data = pack.process.data;
    Object.assign(sandbox.C.PL, pack.personal);
    dom.button = null;
  };
  sandbox.C.post = (name, args, isLocation, dontrun, cb) => {
    assert.equal(pending, undefined, "не более одного запроса одновременно");
    assert.equal(sandbox.TR, false, "запрос отправляется после освобождения родной блокировки");
    assert.equal(dontrun, true);
    held();
    assert.equal(sandbox.C.paths[name], "token:" + requests.length, "каждый запрос использует свежую ссылку");
    if (name === "switch_kit") {
      assert.equal(isLocation, false);
      assert.deepEqual(Object.keys(args), ["kit"]);
      assert.notEqual(args.kit, view, "возврат вида только если показан другой комплект");
    } else {
      assert.equal(name, "inventory_used");
      assert.equal(args.action, "dress", "снятие не используется");
      assert.equal(args.from, "stored");
      assert.equal(args.itarget, (args.slot === "quiver" ? quiver && "arrows" : kits[args.kit][args.slot]) || "",
        "замена указывает актуальную вещь");
    }
    requests.push({ name, ...args });
    pending = { name, args, cb };
    sandbox.loader.style.display = "block";
    sandbox.TR = true;
  };
  sandbox.TR = false;
  vm.runInNewContext(script, sandbox);
  const flush = () => {
    for (const [id, timeout] of [...timeouts]) {
      if (timeout.ms === 0) { timeouts.delete(id); timeout.fn(); }
    }
  };
  const respond = ({ stale = false, refused = false, stillBusy = false } = {}) => {
    const { name, args, cb } = pending;
    pending = undefined;
    if (!stale && !refused && name === "switch_kit") view = args.kit;
    else if (!stale && !refused) {
      view = args.kit;
      if (args.slot === "quiver") quiver = true;
      else {
        const bowInOtherKit = args.iid === "bow" && kits[3 - args.kit].sword === "bow";
        kits[args.kit][args.slot] = bowInOtherKit ? null : args.iid;
      }
      if (args.slot === "sword" && items[args.iid].type === 11 && kits[args.kit].shield === "shield") {
        kits[args.kit].shield = null;
      }
      if (args.iid === "shield" && kits[args.kit].sword === "bow") kits[args.kit].sword = null;
      if (![1, 2].some((kit) => kits[kit].sword === "bow")) quiver = false;
      sandbox.C.PL.health_max = maxHP();
      sandbox.C.PL.health = Math.min(sandbox.C.PL.health, maxHP());
    }
    const token = "token:" + requests.length;
    cb(JSON.stringify({ ...(stale ? {} : { paths: { inventory_used: token, switch_kit: token } }),
      process: { data: data() }, personal: { ...sandbox.C.PL } }));
    sandbox.TR = stillBusy;
    flush();
    if (pending || stillBusy) held();
  };
  const complete = () => {
    for (let i = 0; pending && i < 7; i++) respond();
    assert.equal(pending, undefined, "цепочка завершилась за шесть запросов");
  };
  return { sandbox, kits, dom, requests, messages, timeouts, respond, complete, idle, held, listeners,
    pending: () => pending, view: () => view, quiver: () => quiver };
}

for (const [ranged, initial] of [[false, 1], [false, 2], [true, 1], [true, 2]]) {
  const swap = kitsGame({ ranged, initial });
  assert.deepEqual(swap.listeners.map((l) => l.type), ["click", "keydown", "keyup"], "перехват ввода ставится один раз");
  swap.idle();
  const before = JSON.parse(JSON.stringify(swap.kits));
  const initialHP = swap.sandbox.C.PL.health;
  swap.dom.button.click();
  swap.dom.button.click();
  assert.equal(swap.requests.length, 1, "двойной клик запускает только одну цепочку");
  assert.equal(swap.dom.button.disabled, true);
  swap.held();
  swap.complete();
  assert.deepEqual(swap.kits, { 1: before[2], 2: before[1] }, "обе пары полностью меняются местами");
  assert.equal(swap.view(), initial, "показан исходный комплект");
  assert.equal(swap.sandbox.C.PR.data.kit, initial);
  // Последней шла замена стрел в новом комплекте с луком: он и показан.
  const bowView = ranged ? 2 : 1;
  assert.equal(swap.requests.length, initial === bowView ? 5 : 6,
    "четыре замены рук, возврат стрел и при необходимости один возврат вида");
  assert.equal(swap.requests.filter((r) => r.name === "switch_kit").length, initial === bowView ? 0 : 1);
  if (initial !== bowView) assert.deepEqual(swap.requests[5], { name: "switch_kit", kit: initial });
  swap.idle();
  assert.equal(swap.sandbox.C.PL.health, Math.min(initialHP, swap.sandbox.C.PL.health_max),
    "нет лишней потери HP от промежуточного снятия несовместимого щита");
  assert.ok(swap.sandbox.C.PR.data.items_list.some((item) => item.id === "armor"), "броня остаётся надета");
  assert.equal(swap.quiver(), true, "автоматически снятые сервером стрелы возвращаются в комплект с луком");
  // Количество стрел зависит от показанного комплекта: в ближнем бою их 0.
  assert.equal(swap.sandbox.C.PR.data.items_list.find((item) => item.id === "arrows")?.info.total_quantity,
    initial === bowView ? 30 : 0);
  assert.equal(swap.dom.button.disabled, false);
  assert.deepEqual(swap.messages, []);
  assert.equal(swap.timeouts.size, 0, "после завершения не осталось ожиданий");
  if (!ranged) assert.equal(swap.sandbox.C.PL.health, swap.sandbox.C.PL.health_max,
    "переход на меньший максимум заканчивается с полным HP");
}

const sharedKits = kitsGame({ sharedLeft: true });
sharedKits.dom.button.click();
sharedKits.complete();
assert.equal(sharedKits.requests.length, 3, "совпадающая левая рука не создаёт лишних запросов");

// Без колчана последней меняется левая рука комплекта 2.
for (const initial of [1, 2]) {
  const noArrowsKits = kitsGame({ withoutArrows: true, initial });
  noArrowsKits.dom.button.click();
  noArrowsKits.complete();
  assert.equal(noArrowsKits.requests.length, initial === 2 ? 4 : 5, "без колчана — четыре замены рук и возврат вида");
  assert.equal(noArrowsKits.view(), initial);
  noArrowsKits.idle();
}

const busyKits = kitsGame();
busyKits.dom.button.click();
busyKits.respond({ stillBusy: true });
assert.equal(busyKits.requests.length, 1, "временно занятая очередь не прерывает частичный обмен");
busyKits.held();
assert.deepEqual(busyKits.messages, []);
busyKits.sandbox.TR = false;
const [retryId, retry] = [...busyKits.timeouts.entries()].find(([, t]) => t.ms === 50);
busyKits.timeouts.delete(retryId);
retry.fn();
busyKits.complete();
assert.equal(busyKits.requests.length, 5);
assert.equal(busyKits.timeouts.size, 0);

const unsupportedKits = kitsGame({ twoHanded: true });
unsupportedKits.dom.button.click();
assert.equal(unsupportedKits.requests.length, 0, "непроверенный двуручный комплект не меняется");
assert.equal(unsupportedKits.messages.length, 1);

const twoBowsKits = kitsGame();
twoBowsKits.sandbox.C.PR.data.items_list.find((item) => item.id === "sword").type = 11;
twoBowsKits.dom.button.click();
assert.equal(twoBowsKits.requests.length, 0, "непроверенный обмен двух луков не снимает вещи");
assert.equal(twoBowsKits.messages.length, 1);

for (const failure of ["stale", "refused"]) {
  const swap = kitsGame();
  swap.dom.button.click();
  swap.respond({ [failure]: true });
  swap.dom.button.click();
  assert.equal(swap.requests.length, 1, "после неподтверждённой замены нет продолжения или повтора");
  assert.equal(swap.dom.button.disabled, true);
  assert.equal(swap.messages.length, 1);
  assert.equal(swap.timeouts.size, 0);
  swap.idle();
}

// Сбой единственного запроса возврата вида: без повтора и без новых замен.
for (const failure of ["stale", "refused", "silent"]) {
  const swap = kitsGame({ initial: 2 });
  swap.dom.button.click();
  for (let i = 0; i < 5; i++) swap.respond();
  assert.equal(swap.pending().name, "switch_kit");
  const swapped = JSON.parse(JSON.stringify(swap.kits));
  if (failure === "silent") {
    const [id, deadline] = [...swap.timeouts.entries()].find(([, t]) => t.ms === 15000);
    swap.timeouts.delete(id);
    deadline.fn();
    swap.respond();
  } else swap.respond({ [failure]: true });
  swap.dom.button.click();
  assert.equal(swap.requests.length, 6, "возврат вида не повторяется");
  assert.deepEqual(swap.kits, swapped, "вещи после сбоя возврата не меняются");
  assert.equal(swap.dom.button.disabled, true);
  assert.equal(swap.messages.length, 1);
  assert.equal(swap.timeouts.size, 0);
  swap.idle();
}

const silentKits = kitsGame();
silentKits.dom.button.click();
const [deadlineId, deadline] = [...silentKits.timeouts.entries()].find(([, t]) => t.ms === 15000);
silentKits.timeouts.delete(deadlineId);
deadline.fn();
silentKits.respond();
silentKits.dom.button.click();
assert.equal(silentKits.requests.length, 1, "запоздавший ответ после таймаута не продолжает обмен");
assert.equal(silentKits.dom.button.disabled, true);
assert.equal(silentKits.messages.length, 1);
assert.equal(silentKits.timeouts.size, 0);
silentKits.idle();

const movedKits = kitsGame();
movedKits.dom.button.click();
movedKits.sandbox.C.PR = { intf: "newBattleScene", data: {} };
movedKits.respond();
assert.equal(movedKits.requests.length, 1, "переход на другой экран останавливает обмен");
assert.equal(movedKits.sandbox.C.PR.intf, "newBattleScene", "старый ответ не возвращает экипировку поверх нового экрана");
movedKits.idle();

console.log("fix-my-mist ok");
