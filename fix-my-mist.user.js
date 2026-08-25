// ==UserScript==
// @name         Fix My Mist
// @namespace    https://github.com/netherguy4/fix-my-mist
// @version      1.0.2
// @description  Несколько исправлений для Mist: бой не зависает, длинные списки показываются целиком.
// @author       nether
// @match        https://mist-game.ru/*
// @match        https://www.mist-game.ru/*
// @match        https://world.mist-game.ru/*
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
  const SETTING = "fix-my-mist:";

  // Правки включены по умолчанию: выключение — осознанный выбор, и он
  // переживает обновление скрипта, потому что лежит в localStorage игры.
  function enabled(id) {
    return localStorage.getItem(SETTING + id) !== "off";
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
        window.C.run(JSON.stringify(lastPack));
      };

      const step = () => {
        if (page > last) {
          finish();
          return;
        }
        const wanted = page;
        // Каждый ответ гасит лоадер своим обработчиком — поднимаем его снова.
        loading(true);
        window.C.post(pname, Object.assign({ page: wanted }, extra), isLocation, true, (raw) => {
          let pack;
          try {
            pack = JSON.parse(raw);
          } catch {
            stop();
            return;
          }
          // Сервер выдаёт новый путь на каждый ответ — держим свежий.
          if (pack.paths) Object.assign(window.C.paths, pack.paths);
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
      if (typeof MOD?.pages !== "function" || typeof C?.run !== "function") return false;
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

      const run = C.run;
      C.run = function alxRun() {
        ctrlParams = null;
        const result = run.apply(this, arguments);
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

  const FIXES = [
    { id: "battle-unfreeze", title: "Бой не зависает", run: battleUnfreeze },
    { id: "pages", title: "Длинные списки", run: pagesMultiplier }
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
        commands.push(GM_registerMenuCommand(`${on ? "✔" : "✘"} ${fix.title}`, () => {
          localStorage.setItem(SETTING + fix.id, on ? "off" : "on");
          renderMenu();
          location.reload();
        }));
      }
    };
    renderMenu();
  }
})();
