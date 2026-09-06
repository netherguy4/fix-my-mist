// ==UserScript==
// @name         Fix My Mist
// @namespace    https://github.com/netherguy4/fix-my-mist
// @version      1.4.3
// @description  Исправления для Mist: бой не зависает, маршруты не обрываются, автоход не тормозит, связь не обрывается, длинные списки показываются целиком, лог боя не съезжает под поле.
// @author       nether
// @match        https://mist-game.ru/*
// @match        https://www.mist-game.ru/*
// @match        https://world.mist-game.ru/*
// @match        https://templars-clan.online/*
// @match        https://www.templars-clan.online/*
// @match        https://mist.dev.nether.pp.ua/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @updateURL    https://codeberg.org/netherguy/fix-my-mist/raw/branch/main/fix-my-mist.user.js
// @downloadURL  https://codeberg.org/netherguy/fix-my-mist/raw/branch/main/fix-my-mist.user.js
// ==/UserScript==

// Набор живёт одним файлом: каждая правка — функция, которой отдают окно
// страницы. Под Tampermonkey скрипт исполняется в песочнице, и её window до
// клиента игры не дотягивается, поэтому окно приходит параметром и затеняет
// глобальное имя — тело правки пишется так, будто работает прямо в странице.
(() => {
  "use strict";

  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;

  // На сайте клана нужна только версия: игровые правки здесь запускать нельзя.
  if (["https://templars-clan.online", "https://www.templars-clan.online", "https://mist.dev.nether.pp.ua"].includes(location.origin)) {
    page.addEventListener("message", (event) => {
      if (event.source !== page || event.origin !== location.origin) return;
      const request = event.data;
      if (!request || request.type !== "mist-clan:check-extension" || request.slug !== "fix-my-mist") return;
      if (typeof request.requestId !== "string" || request.requestId.length > 64 || typeof GM_info === "undefined") return;
      page.postMessage({
        type: "mist-clan:extension-status",
        requestId: request.requestId,
        slug: "fix-my-mist",
        version: GM_info.script.version,
        manager: GM_info.scriptHandler || ""
      }, location.origin);
    });
    return;
  }

  const SETTING = "fix-my-mist:";

  // Правки включены по умолчанию: выключение — осознанный выбор, и он
  // переживает обновление скрипта, потому что лежит в localStorage игры.
  function enabled(id) {
    return localStorage.getItem(SETTING + id) !== "off";
  }

  // Отладочная трасса (дев-сборка): последние 200 событий правок в
  // localStorage["fix-my-mist:trace"] — токены ссылок, шаги маршрута.
  const TRACE = SETTING + "trace";
  function trace() {
    let log;
    try {
      log = JSON.parse(localStorage.getItem(TRACE)) || [];
    } catch {
      log = [];
    }
    log.push([new Date().toISOString().slice(11, 19)].concat(Array.prototype.slice.call(arguments)));
    localStorage.setItem(TRACE, JSON.stringify(log.slice(-200)));
  }

  // Разбирают такие случаи через день, а трасса на 200 событий вымывается за
  // минуты игры: в момент обрыва замораживаем её хвост отдельной записью в
  // localStorage["fix-my-mist:incidents"] — последние десять случаев.
  const INCIDENTS = SETTING + "incidents";
  function freeze(why) {
    let tail, all;
    try {
      tail = JSON.parse(localStorage.getItem(TRACE)) || [];
    } catch {
      tail = [];
    }
    try {
      all = JSON.parse(localStorage.getItem(INCIDENTS)) || [];
    } catch {
      all = [];
    }
    all.push({ at: new Date().toISOString(), why, tail: tail.slice(-60) });
    localStorage.setItem(INCIDENTS, JSON.stringify(all.slice(-10)));
  }

  // Бой не зависает.
  //
  // Анимацию хода игра ведёт через TweenHexEngine.CSSAnimate.Animation:
  // play() вешает обработчик AnimationEnd, а тот первым делом проверяет
  // inProgress, который выставляет только AnimationStart. Событие start не
  // приходит, если спрайт в этот момент не анимируется браузером (вкладка в
  // фоне, элемент откреплён от DOM при removeObject) — и тогда не спасает даже
  // страховочный setTimeout самой игры: он зовёт тот же обработчик. onComplete
  // не диспатчится, TaskWorker объекта навсегда остаётся с processingLock, и
  // доска замирает, пока C.PR уходит вперёд: персонаж стоит на старой клетке,
  // убитые мобы висят (их удаление отложено в тот же TaskWorker), а ход
  // приходится доигрывать вслепую. Наблюдалось вживую: очередь персонажа 57
  // задач, lock=true, доска [2, 3] против [2, 6] в C.PR.
  function battleUnfreeze(window) {
    function patch() {
      const proto = window.TweenHexEngine?.CSSAnimate?.Animation?.prototype;
      if (!proto || proto.__fmmAnimationPatched) return Boolean(proto);
      proto.__fmmAnimationPatched = true;
      const play = proto.play;
      proto.play = function fmmPlay() {
        const params = this.params;
        // Зацикленную анимацию (ходьба) обрывать нечем: её и игра не таймерит.
        const looped = Array.isArray(params) && Boolean(params[2]);
        let finished = false;
        this.onComplete.addOnce(() => { finished = true; });
        play.apply(this, arguments);
        if (looped) return;
        const ms = Array.isArray(params) ? parseFloat(params[1]) * 1000 : 0;
        setTimeout(() => {
          if (finished) return;
          finished = true;
          // stop() гасит inProgress, поэтому запоздавший AnimationEnd игры
          // уже не сработает вторым разом.
          this.stop();
          this.onComplete.dispatch();
        }, (ms || 1500) + 500);
      };
      return true;
    }

    // Клиент игры грузится своим прелоадером — движка на document-start ещё нет.
    if (patch()) return;
    const waiting = setInterval(() => {
      if (patch()) clearInterval(waiting);
    }, 500);
    setTimeout(() => clearInterval(waiting), 60000);
  }

  // Маршрут не обрывается.
  //
  // Таймер игры ждёт округлённый next_turn (секунды), хотя сервер присылает
  // точный next_turn_ms. Поэтому следующий шаг иногда уходит на сотни
  // миллисекунд раньше, сервер отвечает action_success=false, а клиент очищает
  // оставшийся маршрут. Ставим шаг точно на next_turn_ms, а следующий родной
  // тик гасим как дубль, пока сервер ещё не успел прислать новую позицию.
  function adventureRouteTiming(window) {
    function patch() {
      const C = window.C;
      const step = C?.stepHexTimerAdventure;
      if (typeof step !== "function" || step.__fmmRouteTimingPatched) return Boolean(step);
      // Родной тик при diff==0 стирает маршрут, если персонаж не сдвинулся с
      // прошлого шага — в том числе когда ответ на шаг просто ещё не пришёл.
      // Пока ждём ответ (next_turn_ms не сменился), тики глотаем, но не дольше
      // WAIT_TICKS секунд: если ответ потерян, маршрут должен погаснуть.
      const WAIT_TICKS = 5;
      let waitingFor = 0;
      let sentFor = 0;
      let swallowed = 0;
      let attempts = 0;
      let lastTimerContext = null;
      let lastTimerArgs = null;
      const state = () => {
        const PR = C.PR || {};
        const self = PR.map && PR.map.self;
        const at = PR.map && PR.map.obj && PR.map.obj[self];
        const way = PR.adventure_way;
        const last = PR.adventure && PR.adventure.coord;
        return [way ? way.length : "-", at ? at.join(",") : "?", last ? last.join(",") : "?", PR.data && PR.data.reset_way ? "reset" : ""];
      };
      // Остаток маршрута игра стирает молча. Считаем это обрывом, когда за один
      // тик пропало больше одного шага: последний шаг маршрут доигрывает и сам.
      const wayLen = () => (C.PR?.adventure_way || []).length;
      function stepAndWatch(why, context, args) {
        attempts++;
        const before = wayLen();
        const result = step.apply(context, args);
        if (before > 1 && wayLen() === 0) freeze(why);
        return result;
      }
      function fmmStepHexTimerAdventure(timer) {
        if (timer?.diff === 0) {
          lastTimerContext = this;
          lastTimerArgs = arguments;
        }
        const next = Number(C.PR?.next_turn_ms);
        if (sentFor && sentFor !== next) sentFor = 0;
        if (timer?.diff === 0 && sentFor && sentFor === next) {
          C.PR.start_time_diff = 0;
          if (++swallowed < WAIT_TICKS) {
            trace("route", "wait", swallowed, ...state());
            return;
          }
          sentFor = 0;
          trace("route", "timeout", ...state());
          return stepAndWatch("timeout", this, arguments);
        }
        if (timer?.diff === 0 && next > +C.sdate) {
          C.PR.start_time_diff = 0;
          if (waitingFor !== next) {
            waitingFor = next;
            trace("route", "defer", next - +C.sdate, ...state());
            const process = C.PR;
            const context = this;
            const args = arguments;
            setTimeout(() => {
              if (waitingFor !== next) return;
              waitingFor = 0;
              if (C.PR !== process || Number(process.next_turn_ms) !== next) {
                trace("route", "skip", ...state());
                return;
              }
              sentFor = next;
              swallowed = 0;
              trace("route", "step", ...state());
              stepAndWatch("step", context, args);
            }, next - +C.sdate);
          }
          return;
        }
        waitingFor = 0;
        if (timer?.diff !== 0) return step.apply(this, arguments);
        trace("route", "native", ...state());
        return stepAndWatch("native", this, arguments);
      }
      fmmStepHexTimerAdventure.__fmmRouteTimingPatched = true;
      C.stepHexTimerAdventure = fmmStepHexTimerAdventure;

      // Ответ на шаг иногда приходит «пустым»: сервер отвечает и выдаёт свежий
      // токен, но позиция и next_turn_ms остаются прежними — тики уходят в
      // wait, и маршрут гаснет по таймауту. Пишем ответы хода: по трассе видно,
      // чем такой ответ отличается от удачного.
      const run = C.run;
      C.run = function fmmRunRouteTrace(raw) {
        let retryFor = 0;
        let retryAfterAttempt = 0;
        try {
          const p = (typeof raw === "string" ? JSON.parse(raw) : raw)?.process;
          if (p && /__path=adventure&/.test(String(p.qs))) {
            // Отказ завершает запрос, даже если next_turn_ms не изменился. При
            // успехе sentFor держим до применения ответа клиентом: координата
            // обновляется не сразу, и ранний тик на старой позиции стирает путь.
            const pending = sentFor;
            if (p.action_success === false) sentFor = 0;
            if (pending && p.action_success === false
              && Number(p.next_turn_ms) === pending && (p.adventure_way || []).length) {
              retryFor = pending;
              retryAfterAttempt = attempts;
            }
            const at = p.map?.obj?.[p.map.self];
            trace("adv<-", p.action, p.action_success, p.next_turn_ms, at ? at.slice(0, 2).join(",") : "?",
              (p.adventure_way || []).length, p.status, p.mode, p.exec_time);
          }
        } catch {
          // Трасса не должна ронять ответ игры.
        }
        const result = run.apply(this, arguments);
        if (retryFor && lastTimerArgs) {
          const process = C.PR;
          setTimeout(() => {
            // Родной секундный тик или другой пакет могли уже продвинуть
            // маршрут. В таком случае повтор превратился бы в двойной шаг.
            if (attempts !== retryAfterAttempt || C.PR !== process
              || Number(process.next_turn_ms) !== retryFor
              || !(process.adventure_way || []).length) return;
            trace("route", "retry", ...state());
            fmmStepHexTimerAdventure.apply(lastTimerContext, lastTimerArgs);
          }, 0);
        }
        return result;
      };
      return true;
    }

    if (patch()) return;
    const waiting = setInterval(() => {
      if (patch()) clearInterval(waiting);
    }, 500);
    setTimeout(() => clearInterval(waiting), 60000);
  }

  // Автоход без задержки.
  //
  // На карте мира сервер разрешает следующий шаг через date_next_step, но
  // штатный автоход проверяет его только общим секундным таймером. Будим родной
  // обработчик точно в разрешённый момент; сам маршрут и запрос остаются его.
  function worldMapSpeed(window) {
    function patch() {
      const C = window.C;
      const step = C?.stepHexTimer;
      if (typeof step !== "function" || step.__fmmWorldSpeedPatched) return Boolean(step);
      let waitingFor = 0;
      let sentFor = 0;
      const serverNow = () => Date.now() + Number(C.clockdiff || 0);
      const canStep = () => C.PR?.intf === "worldMap"
        && window.worldMap?.way?.length > 0
        && C.PR.data?.coord !== undefined
        && window.worldMap.coord !== C.PR.data.coord;

      function send(ready, context, args) {
        waitingFor = 0;
        if (!canStep() || Number(C.PR.data.date_next_step) * 1000 !== ready) return;
        C.sdate = new Date(serverNow());
        C.PR.start_time_diff = 0;
        sentFor = ready;
        const result = step.apply(context, args);
        // Один штатный тик не должен повторить шаг до ответа сервера.
        C.PR.start_time_diff = 1;
        return result;
      }

      function fmmStepHexTimer(value) {
        const ready = Number(value) * 1000;
        if (sentFor && sentFor !== ready) sentFor = 0;
        if (sentFor && sentFor === ready) {
          sentFor = 0;
          return step.apply(this, arguments);
        }
        if (!canStep() || !Number.isFinite(ready)) {
          waitingFor = 0;
          return step.apply(this, arguments);
        }

        const now = serverNow();
        if (ready <= now) return send(ready, this, arguments);
        const result = step.apply(this, arguments);
        if (waitingFor !== ready) {
          waitingFor = ready;
          const process = C.PR;
          const context = this;
          const args = arguments;
          setTimeout(() => {
            if (waitingFor !== ready) return;
            if (C.PR !== process) {
              waitingFor = 0;
              return;
            }
            send(ready, context, args);
          }, ready - now);
        }
        return result;
      }

      fmmStepHexTimer.__fmmWorldSpeedPatched = true;
      C.stepHexTimer = fmmStepHexTimer;
      return true;
    }

    if (patch()) return;
    const waiting = setInterval(() => {
      if (patch()) clearInterval(waiting);
    }, 500);
    setTimeout(() => clearInterval(waiting), 60000);
  }

  // Связь не обрывается.
  //
  // Сокет «чата» — это канал сервера в клиент целиком: по нему приходят и
  // строки чата, и команды игры. Замер вживую в бою: 47 пакетов подряд, все до
  // одного — battleMove и battleRefresh. Поэтому упавший сокет замораживает не
  // только чат, но и поле боя: доска стоит, пока игрок не нажмёт «обновить».
  //
  // Вернуть сокет должен клиент, но обе его дороги ведут в тупик. Свой
  // реконнект Socket.connect() съедает сам: увидев прежний conn, он закрывает
  // уже закрытое соединение и выходит, а второго close SockJS не пришлёт.
  // Остаётся дорога через игру: на close она шлёт get_key и заводит новый сокет
  // только из колбэка ответа, а ошибку запроса C.post глотает молча
  // (errorHandler колбэк не зовёт). Один сетевой сбой — и связь потеряна
  // навсегда, причём INTF.CHAT.connected остаётся true, а запасного опроса нет:
  // chat_list заводится только автообновлением при смене канала.
  //
  // Правка сторожит сокет и, если он мёртв дольше форы родного пути, зовёт
  // родной же autoReconnect. Заодно закрывает сокет, который игра теряет при
  // создании нового: потерянный остаётся открытым и шлёт те же команды второй раз.
  function socketReconnect(window) {
    // Родному пути хватает ответа get_key плюс его собственных трёх секунд.
    // Больше не ждём: каждая лишняя секунда — это замерший бой.
    const DEAD_MS = 5000;
    function patch() {
      const CHAT = window.INTF?.CHAT;
      if (!CHAT || CHAT.__fmmSocketReconnect) return Boolean(CHAT);
      CHAT.__fmmSocketReconnect = true;

      const createSocket = CHAT.createSocket;
      CHAT.createSocket = function () {
        const old = this.socket;
        const result = createSocket.apply(this, arguments);
        if (old && old !== this.socket && old.conn) {
          old.conn.close();
          old.conn = false;
        }
        return result;
      };

      let deadSince = 0;
      setInterval(() => {
        const conn = CHAT.socket && CHAT.socket.conn;
        // SockJS: 0 — соединяется, 1 — открыт. false здесь — съеденный реконнект.
        if (conn && (conn.readyState === 0 || conn.readyState === 1)) {
          deadSince = 0;
          return;
        }
        const now = Date.now();
        if (!deadSince) deadSince = now;
        if (now - deadSince < DEAD_MS) return;
        deadSince = 0;
        CHAT.autoReconnect();
      }, 1000);
      return true;
    }

    if (patch()) return;
    const waiting = setInterval(() => {
      if (patch()) clearInterval(waiting);
    }, 500);
    setTimeout(() => clearInterval(waiting), 60000);
  }

  // Лог боя не съезжает.
  //
  // Поле боя и лог — два соседних float-блока внутри #battle_f, и ширины им
  // считает сама игра (обработчик resize у .battleFieldContainer):
  //   G = $("#battle_f").width(); поле = Math.round(G * доля); лог = G - поле.
  // При зуме страницы, отличном от 100%, реальная ширина #battle_f дробная —
  // при 150% это 1224.67 px, — а G целое, 1225. Сумма выставленных ширин
  // (674 + 551) выходит шире родителя на треть пикселя, второму float не
  // хватает места в строке, и лог переносится вниз: оказывается под полем боя,
  // за пределами видимой области, и выглядит как пропавший.
  // Правка отдаёт логу пару пикселей запаса в margin-box. Сам блок остаётся
  // прежней ширины и рисуется как раньше — за край родителя уходит меньше
  // пикселя, и тот всё равно обрезан #cutter. Ширины игра пересчитывает при
  // каждом ресайзе, поэтому запас держится стилем, а не разовой правкой.
  function battleLogRow(window) {
    const style = window.document.createElement("style");
    style.textContent = "#battle_f > #info_block { margin-right: -3px }";
    // На document-start head ещё нет, а documentElement уже есть.
    (window.document.head || window.document.documentElement).appendChild(style);
  }

  // Длинные списки.
  //
  // Вся пагинация игры — рюкзак, аукцион, рынок, склад, лавки, списки — рисуется
  // одной функцией MOD.pages и грузится одним запросом {page: N}: itemsScene
  // вешает клик через C.PR.itemFilter, остальные экраны — через контрол UI.pages.
  // Отсюда патч из двух зацепок:
  //   MOD.pages — номера страниц пересчитываются в блоки по N штук, рядом встаёт
  //               селект «сколько страниц показывать за раз»;
  //   C.run     — после ответа сервера недостающие страницы блока догружаются и
  //               склеиваются в один список.
  // Размер страницы клиенту недоступен: в самом клиенте слова per_page нет,
  // принимаемые фильтры сервер объявляет в search_params и размера среди них
  // нет, строка запроса подписана (лишний GET-параметр — «Checking failed :
  // qs-ptn»), а 34 варианта в теле запроса сервер молча игнорирует. Поэтому блок
  // и собирается N запросами.
  function pagesMultiplier(window) {
    // Флаг тот же, что у прежней версии этой правки: там, где остался её
    // старый билд, пагинация не зацепится дважды.
    if (window.__alxPagesHooked) return;
    window.__alxPagesHooked = true;

    const KEY = "fix-my-mist-pages-mult";
    const STEPS = [1, 2, 3, 5, 10];
    const CLASS = "alx-pages-mult";
    const STUCK_MS = 15000;

    let busy = false;
    let hooked = false;
    let rerun = false;
    let ownPost = false;
    // Экраны вне itemsScene носят имя запроса в параметрах контрола UI.pages.
    let ctrlParams = null;

    function clamp(value) {
      return STEPS.indexOf(value) === -1 ? 1 : value;
    }

    // Множитель помнится на список: рюкзак и скупка — разные вкладки одного
    // intf, поэтому вкладка входит в ключ.
    function screenKey() {
      const PR = window.C && window.C.PR;
      if (!PR) return KEY;
      const tab = PR.data && PR.data.current_tab;
      return KEY + ":" + String(PR.intf || "") + (tab === undefined || tab === null ? "" : ":" + tab);
    }

    function mult() {
      const own = localStorage.getItem(screenKey());
      // Общая настройка прежних версий остаётся значением по умолчанию.
      return clamp(Number(own === null ? localStorage.getItem(KEY) : own));
    }

    function selectHTML() {
      const current = mult();
      const options = STEPS
        .map((n) => `<option value="${n}"${n === current ? ' selected="selected"' : ""}>&times;${n}</option>`)
        .join("");
      return `<select class="${CLASS} d2brown" style="margin-left:5px" title="Сколько страниц игры показывать за раз">${options}</select>`;
    }

    // Куда слать запрос за страницей: как это делает сама игра.
    function target() {
      if (ctrlParams) {
        return [ctrlParams.pname || "refresh", ctrlParams.isLocation, ctrlParams.advPostArgs || {}];
      }
      const links = window.C.PR && window.C.PR.data && window.C.PR.data.links;
      const def = links && links["default"];
      return Array.isArray(def) ? [def[0], def[1], {}] : ["refresh", false, {}];
    }

    // Списки страницы — те массивы, длина которых равна размеру страницы.
    function listKeys(data) {
      const size = Number(data.pages && data.pages.per_page) || 0;
      return Object.keys(data).filter(
        (key) => Array.isArray(data[key]) && (data[key].length === size || key === "items_list")
      );
    }

    // Кроме списка страница несёт справочники под него — на рынке это users,
    // владельцы лавок. Они тоже свои на каждой странице, и без склейки карточки
    // чужих страниц остаются с undefined вместо ника. Ключи в справочнике — id,
    // этим он и отличается от настроек экрана вроде pages и search_params.
    function tableKeys(data) {
      return Object.keys(data).filter((key) => {
        const value = data[key];
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const ids = Object.keys(value);
        return ids.length > 0 && ids.every((id) => /^\d+$/.test(id));
      });
    }

    function stamp(data) {
      data.__alxMult = mult();
    }

    // Трасса одноразовых токенов ссылок (__lnkprtn). Сервер выдаёт новый токен в
    // каждом ответе, а на устаревший отвечает без paths и молча не выполняет
    // действие — так «не применяется ожерелье» до перезагрузки. Кто израсходовал
    // токен, по симптому не видно, поэтому пишем последние отправки (игра или
    // наш множитель), ответы (свежий токен или STALE) и ошибки запросов.
    const tok = (s) => (String(s || "").match(/__lnkprtn=(\w{6})/) || [])[1];

    function tracePack(pack, from) {
      const qs = pack && pack.process && pack.process.qs;
      const sent = tok(qs);
      const paths = pack && pack.paths && Object.keys(pack.paths).length ? pack.paths : null;
      // Ходы боя идут раз в секунду и вымывают из буфера всё остальное; пуши
      // (rs) интересны только когда несут ссылки.
      if (/__path=battle&/.test(qs) || (!sent && !paths)) return;
      const fresh = Object.keys(paths || {}).map((k) => k + ":" + tok(paths[k])).join(",");
      trace(from + "<-", sent || String(qs).slice(0, 12), fresh || "STALE");
    }

    // Токен одноразовый: отправили — сгорел, ответ несёт следующий. Ссылки у игры
    // лежат в двух местах: C.paths и C.pack.paths. После пакета без paths C.pack
    // становится новым клоном, а C.paths остаётся старым объектом, и следующий
    // пакет с paths склеивается из C.pack.paths — свежий токен надо класть в оба,
    // иначе после боя, начатого предметом, игра возвращается к потраченному.
    function setPaths(paths) {
      const C = window.C;
      Object.assign(C.paths, paths);
      if (C.pack && C.pack.paths && C.pack.paths !== C.paths) Object.assign(C.pack.paths, paths);
    }

    // Страховка на случай, если потраченный токен всё же приехал в пакете.
    const spent = {};
    const latest = {};
    function keepFresh(pack, from) {
      const paths = pack && pack.paths;
      if (!paths) return;
      Object.keys(paths).forEach((name) => {
        const t = tok(paths[name]);
        if (!t) return;
        if (spent[t] && latest[name] && tok(latest[name]) !== t) {
          const fresh = {};
          fresh[name] = latest[name];
          setPaths(fresh);
          trace("revert", from, name, t, tok(latest[name]));
        } else latest[name] = paths[name];
      });
    }

    // Сервер отдаёт страницу за ~250 мс и отвечает 423 на параллельные запросы,
    // так что блок собирается по одной странице: показываем родной лоадер игры,
    // иначе список молча дёргается через пару секунд.
    function loading(on) {
      const el = document.getElementById("loading_wnd");
      if (el) el.style.display = on ? "block" : "none";
    }

    // Блоки уместны только там, где страницы реально склеиваются: у экрана есть
    // список длиной в страницу либо он уже склеен нами.
    function canExpand(data) {
      if (!data || !data.pages) return false;
      return data.__alxMult === mult() || listKeys(data).length > 0;
    }

    function expand() {
      const data = window.C.PR && window.C.PR.data;
      const pages = data && data.pages;
      if (!pages || !(Number(pages.pages) > 1)) return;

      const size = mult();
      const first = Number(pages.page) || 1;
      const last = Math.min(first + size - 1, Number(pages.pages));
      const keys = listKeys(data);
      if (last <= first || !keys.length) {
        stamp(data);
        return;
      }

      const [pname, isLocation, extra] = target();
      const tables = tableKeys(data);
      const merged = {};
      keys.forEach((key) => {
        merged[key] = data[key].slice();
      });
      tables.forEach((key) => {
        merged[key] = Object.assign({}, data[key]);
      });

      let page = first + 1;
      let lastPack = null;
      busy = true;
      const release = setTimeout(() => {
        busy = false;
        loading(false);
      }, STUCK_MS);

      const stop = () => {
        clearTimeout(release);
        busy = false;
        loading(false);
      };

      const finish = () => {
        stop();
        if (!lastPack) return;
        const part = lastPack.process && lastPack.process.data;
        if (!part) return;
        Object.keys(merged).forEach((key) => {
          part[key] = merged[key];
        });
        // Блок показывается на месте своей первой страницы.
        if (part.pages) part.pages.page = first;
        part.__alxMult = size;
        rerun = true;
        try {
          window.C.run(JSON.stringify(lastPack));
        } finally {
          rerun = false;
        }
      };

      const step = () => {
        if (page > last) {
          finish();
          return;
        }
        const wanted = page;
        // Каждый ответ гасит лоадер своим обработчиком — поднимаем его снова.
        loading(true);
        ownPost = true;
        window.C.post(pname, Object.assign({ page: wanted }, extra), isLocation, true, (raw) => {
          let pack;
          try {
            pack = JSON.parse(raw);
          } catch {
            stop();
            return;
          }
          tracePack(pack, "pages");
          // Сервер выдаёт новый путь на каждый ответ — держим свежий.
          if (pack.paths) setPaths(pack.paths);
          keepFresh(pack, "pages");
          const part = pack.process && pack.process.data;
          if (!part) {
            stop();
            return;
          }
          keys.forEach((key) => {
            if (Array.isArray(part[key])) merged[key] = merged[key].concat(part[key]);
          });
          tables.forEach((key) => {
            if (part[key] && typeof part[key] === "object") Object.assign(merged[key], part[key]);
          });
          lastPack = pack;
          page = wanted + 1;
          step();
        });
        ownPost = false;
      };

      step();
    }

    function afterRun() {
      if (mult() < 2 || busy) return;
      const data = window.C.PR && window.C.PR.data;
      if (!data || data.__alxMult === mult()) return;
      expand();
    }

    // Смена множителя: перезапрашиваем текущую страницу обычным путём, дальше
    // сработает afterRun.
    function reload() {
      const pages = window.C.PR && window.C.PR.data && window.C.PR.data.pages;
      if (!pages) return;
      const [pname, isLocation, extra] = target();
      window.C.post(pname, Object.assign({ page: Number(pages.page) || 1 }, extra), isLocation);
    }

    document.addEventListener(
      "change",
      (event) => {
        const select = event.target;
        if (!select || !select.classList || !select.classList.contains(CLASS)) return;
        event.stopPropagation();
        localStorage.setItem(screenKey(), String(clamp(Number(select.value))));
        reload();
      },
      true
    );

    function hook() {
      if (hooked) return true;
      const C = window.C;
      const MOD = window.MOD;
      const UI = window.UI;
      if (typeof MOD?.pages !== "function" || typeof C?.run !== "function" || typeof C.post !== "function") return false;
      if (typeof UI?.pages !== "function") return false;
      hooked = true;

      const pages = MOD.pages;
      MOD.pages = function alxPages(data) {
        const rest = Array.prototype.slice.call(arguments, 1);
        const screen = window.C.PR && window.C.PR.data;
        // Чужая пагинация (не текущего экрана или без склеиваемого списка) — как была.
        if (!data || !Number(data.pages) || !screen || data !== screen.pages || !canExpand(screen)) {
          return pages.apply(this, arguments);
        }
        const step = mult();
        if (step < 2) {
          return pages.apply(this, arguments) + selectHTML();
        }
        const blocks = {
          records: data.records,
          per_page: (Number(data.per_page) || 0) * step,
          pages: Math.ceil(Number(data.pages) / step),
          page: Math.floor(((Number(data.page) || 1) - 1) / step) + 1
        };
        // id страницы — номер её первой игровой страницы: клик уходит на сервер как есть.
        const html = pages
          .apply(this, [blocks].concat(rest))
          .replace(/id="page_(\d+)"/g, (_, n) => `id="page_${(Number(n) - 1) * step + 1}"`);
        return html + selectHTML();
      };

      const setHandlers = UI.pages.prototype.setHandlers;
      UI.pages.prototype.setHandlers = function alxSetHandlers() {
        ctrlParams = this.params;
        return setHandlers.apply(this, arguments);
      };

      const post = C.post;

      C.post = function alxPost(pname, data, isLocation) {
        const paths = window.C.paths || {};
        const path = isLocation ? (paths.location || {})[pname] : paths[pname] || (paths.location || {})[pname];
        const t = tok(path);
        // При TR игра запрос не шлёт — в трассе он только запутает.
        if (!t || window.TR) return post.apply(this, arguments);
        spent[t] = true;
        if (pname !== "battle") trace((ownPost ? "pages" : "game") + "->", pname, t, JSON.stringify(data || {}).slice(0, 80));
        return post.apply(this, arguments);
      };
      if (typeof window.jQuery === "function") {
        window.jQuery(document).ajaxError((_, xhr, opts) => {
          const t = tok(opts && opts.url);
          if (t) trace("error", xhr && xhr.status, t);
        });
      }

      const run = C.run;
      C.run = function alxRun(raw) {
        ctrlParams = null;
        let pack = null;
        try {
          pack = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          // Битый ответ игра отругает сама.
        }
        if (!rerun) tracePack(pack, "game");
        const result = run.apply(this, arguments);
        keepFresh(pack, String(pack && pack.process && pack.process.qs).slice(0, 12));
        // Проигнорированный запрос (потраченный токен, ответ без paths): экран
        // нарисован как есть, догружать его незачем.
        if (pack && !pack.paths && tok(pack.process && pack.process.qs)) return result;
        // Сцена рисуется коллбэком, параметры UI.pages появляются только там.
        setTimeout(() => {
          try {
            afterRun();
          } catch {
            // Догрузка страниц не должна ломать игру.
          }
        }, 0);
        return result;
      };

      return true;
    }

    // Клиент игры грузится своим прелоадером, так что хук нередко встаёт уже
    // после первого рендера: экран нарисован родной пагинацией, и C.run по нему
    // больше не придёт. Догоняем — дорисовываем селект и собираем блок сами.
    function catchUp() {
      if (busy) return false;
      const data = window.C.PR && window.C.PR.data;
      if (!data || !data.pages) return false;
      if (!document.querySelector(".page")) return false;
      if (document.querySelector("." + CLASS)) return true;
      if (mult() > 1) afterRun();
      else if (window.INTF && window.INTF.SCN && window.INTF.SCN.current) {
        window.INTF.SCN.set(window.INTF.SCN.current, data);
      }
      return true;
    }

    const tick = () => hook() && catchUp();

    if (!tick()) {
      const waiting = setInterval(() => {
        if (tick()) clearInterval(waiting);
      }, 100);
      setTimeout(() => clearInterval(waiting), 60000);
    }
  }

  // Правка на обкатке помечается `experimental`: в меню менеджера скриптов к ней
  // дописывается «эксперимент», а витрина на mist-clan вычитывает этот же флаг
  // прямо из текста скрипта и рисует метку у карточки. Так пометка живёт в
  // одном месте — снимаем её здесь, и на сайте она пропадает сама. Строку с
  // правкой держим однострочной: витрина разбирает её регулярным выражением.
  const FIXES = [
    { id: "battle-unfreeze", title: "Бой не зависает", experimental: true, run: battleUnfreeze },
    { id: "adventure-route", title: "Маршрут не обрывается", experimental: true, run: adventureRouteTiming },
    { id: "world-map-speed", title: "Автоход без задержки", experimental: true, run: worldMapSpeed },
    { id: "socket-reconnect", title: "Связь не обрывается", experimental: true, run: socketReconnect },
    { id: "battle-log-row", title: "Лог боя не съезжает", experimental: true, run: battleLogRow },
    { id: "pages", title: "Длинные списки", experimental: true, run: pagesMultiplier }
  ];

  for (const fix of FIXES) {
    if (!enabled(fix.id)) continue;
    try {
      fix.run(page);
    } catch (error) {
      // Одна упавшая правка не должна уносить остальные и саму игру.
      console.error("[Fix My Mist] " + fix.id, error);
    }
  }

  // Выключатель живёт в меню менеджера скриптов: своя панель в игре стоила бы
  // больше кода, чем все правки вместе. Правки цепляются за клиент один раз при
  // загрузке, отцепить их на ходу нечем — поэтому переключение перезагружает
  // страницу.
  if (typeof GM_registerMenuCommand === "function") {
    const commands = [];
    const renderMenu = () => {
      if (typeof GM_unregisterMenuCommand === "function") {
        for (const id of commands.splice(0)) GM_unregisterMenuCommand(id);
      }
      for (const fix of FIXES) {
        const on = enabled(fix.id);
        const mark = fix.experimental ? " · эксперимент" : "";
        commands.push(GM_registerMenuCommand(`${on ? "✔" : "✘"} ${fix.title}${mark}`, () => {
          localStorage.setItem(SETTING + fix.id, on ? "off" : "on");
          renderMenu();
          location.reload();
        }));
      }
    };
    renderMenu();
  }
})();
