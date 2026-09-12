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

console.log("fix-my-mist ok");
