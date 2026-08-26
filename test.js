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
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    setInterval: (fn) => ticks.push(fn),
    clearInterval() {},
    GM_registerMenuCommand: (label) => menu.push(label) && menu.length,
    timers, ticks, posted, loader, menu, saved, serverPage,
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
  "✔ Лог боя не съезжает · эксперимент",
  "✘ Длинные списки · эксперимент"
],
  "меню показывает состояние каждой правки");

// Маршрут ждёт точный next_turn_ms, даже когда секундный таймер уже показал 0.
const route = game();
route.C.sdate = 1499;
route.C.PR.next_turn_ms = 1500;
route.C.PR.start_time_diff = 1;
route.steps = 0;
route.C.stepHexTimerAdventure = () => { route.steps++; };
vm.runInNewContext(`
  ${script}
  C.stepHexTimerAdventure({ diff: 0 });
  const early = { steps, startTimeDiff: C.PR.start_time_diff };
  C.sdate = 1500;
  C.stepHexTimerAdventure({ diff: 0 });
  result = { early, steps };
`, route);
assert.deepEqual(route.result.early, { steps: 0, startTimeDiff: 0 },
  "ранний нулевой тик не отправляет шаг и оставляет маршрут готовым к следующему тику");
assert.equal(route.result.steps, 1, "в точное серверное время родной обработчик делает шаг");

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

console.log("fix-my-mist ok");
