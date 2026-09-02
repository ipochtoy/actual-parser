/* shipment-scope.js — состав ОДНОЙ отправки Amazon (v7.9.0)
 *
 * Зачем файл: 02.09.2026 на заказе 114-4364449-9800232 (одна отправка, четыре куклы)
 * скринер записал в лист ОДНУ строку («Valentina & Cinder», qty 1), а робот описи
 * пересказал её складу как «В посылке 1 товар» — склад пришил одну вещь из четырёх.
 * Причина: товар отправки искали по itemId из ссылки кнопки Track (одна ссылка → один
 * товар), разбор всей рамки доставки стоял ПОЗЖЕ и потому не выполнялся вовсе, а сама
 * рамка ловилась в том числе по `.a-box` — у Amazon этот класс висит и на рамке ОДНОГО
 * товара.
 *
 * Правило: одна отправка = ВСЕ её товары. Не смогли разобрать — говорим об этом вслух
 * (пометка + пустой qty), число позиций при этом не печатаем.
 *
 * Файл подключается двумя способами:
 *   1) как content-script (manifest.json, ПЕРЕД content-amazon.js — порядок в массиве
 *      js[] Chrome соблюдает, оба скрипта живут в одном изолированном мире);
 *   2) офлайн-тестом (AutoBuy: tests/e2e/parser-pro-amazon-shipments.spec.mjs).
 * Внутри — только чистые функции над DOM: ни сети, ни chrome.*, ни своего состояния.
 */
(function (root) {
  'use strict';

  /** Кнопка отправки — тот же набор, что и в главном цикле парсера. */
  const TRACK_BUTTON_SELECTOR = 'a[href*="ship-track"], a[href*="track-package"], a[href*="progress-tracker"]';

  /** Ссылка на товар. */
  const PRODUCT_LINK_SELECTOR = 'a[href*="/dp/"], a[href*="/gp/product/"]';

  /** Шапка рамки доставки: «Delivered Aug 30», «Arriving tomorrow». */
  const SHIPMENT_HINT_SELECTOR = '.delivery-box__primary-text, .yohtmlc-shipment-status-primaryText';

  /** Рамка ОДНОЙ позиции внутри отправки. */
  const ITEM_SCOPE_SELECTOR = '.yohtmlc-item, [data-test-id="item-row"], .a-fixed-left-grid-inner, .a-row';

  function countTrackButtons(el) {
    if (!el || !el.querySelectorAll) return 0;
    return el.querySelectorAll(TRACK_BUTTON_SELECTOR).length;
  }

  function hasProducts(el) {
    return !!(el && el.querySelector && el.querySelector(PRODUCT_LINK_SELECTOR));
  }

  function asinOf(link) {
    const href = (link && (link.getAttribute('href') || link.href)) || '';
    const m = String(href).match(/\/(?:dp|product)\/([A-Z0-9]{8,10})/i);
    return m ? m[1].toUpperCase() : '';
  }

  /** Ближайшая рамка позиции над узлом (та же логика, что у парсера Amazon). */
  function closestItemScope(node) {
    const isItem = (el) => el && el.matches && el.matches(ITEM_SCOPE_SELECTOR);
    let cur = node;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) if (isItem(cur)) return cur;
    return node;
  }

  /**
   * Рамка ОДНОЙ отправки вокруг кнопки Track.
   *
   * Берём самого маленького предка кнопки, внутри которого ровно ОДНА кнопка отправки
   * и есть хотя бы один товар; выше карточки заказа не поднимаемся. Если среди таких
   * предков есть несущий шапку доставки («Delivered …») — берём его: это и есть рамка
   * доставки целиком, а рамка поменьше может держать только часть товаров.
   *
   * @param {Element} trackBtn кнопка Track package
   * @param {Element} card карточка заказа (граница подъёма)
   * @returns {{box: Element|null, isolated: boolean, reason: string}}
   *   isolated=false + reason='scope-multi-track' — вокруг товаров больше одной кнопки
   *   отправки: чей товар в какой посылке, по разметке не видно.
   */
  function shipmentScope(trackBtn, card) {
    const chain = [];
    let cur = trackBtn && trackBtn.parentElement;
    for (let i = 0; i < 40 && cur; i++) {
      chain.push(cur);
      if (card && cur === card) break;
      cur = cur.parentElement;
    }

    if (!chain.length) {
      return { box: card || null, isolated: false, reason: 'scope-multi-track' };
    }

    const solo = chain.filter((el) => countTrackButtons(el) === 1);
    const withGoods = solo.filter(hasProducts);

    if (withGoods.length) {
      const hinted = withGoods.filter((el) => el.querySelector(SHIPMENT_HINT_SELECTOR));
      return { box: hinted[0] || withGoods[0], isolated: true, reason: '' };
    }

    // Ни одна рамка с ровно одной кнопкой не держит товаров: либо кнопок в блоке
    // несколько, либо товаров рядом нет. Отдаём самую широкую рамку, чтобы товары всё
    // же перечислить, но помечаем состав как неразобранный.
    const widest = solo.length ? solo[solo.length - 1] : (card || chain[chain.length - 1]);
    return { box: widest, isolated: false, reason: 'scope-multi-track' };
  }

  /**
   * Все товары отправки — по одной записи на позицию.
   *
   * Группируем по рамке позиции, а НЕ по ASIN: у одного товара обычно две ссылки
   * (картинка и название) — это одна позиция; а один и тот же ASIN в РАЗНЫХ рамках —
   * это разные позиции (пять банок одного товара = пять строк, у каждой свой значок
   * количества). Внутри рамки различаем ещё и по ASIN — если разметка съехала и две
   * разные вещи попали в одну рамку, обе останутся видны.
   *
   * @param {Element} box рамка отправки из shipmentScope
   * @returns {Element[]} ссылки на товары в порядке страницы
   */
  function collectShipmentProducts(box) {
    const out = [];
    if (!box || !box.querySelectorAll) return out;
    const seen = new Map(); // рамка позиции → уже взятые из неё ключи
    box.querySelectorAll(PRODUCT_LINK_SELECTOR).forEach((link) => {
      const scope = closestItemScope(link);
      let taken = seen.get(scope);
      if (!taken) { taken = new Set(); seen.set(scope, taken); }
      const key = asinOf(link) || String(link.getAttribute('href') || link.href || '');
      if (taken.has(key)) return;
      taken.add(key);
      out.push(link);
    });
    return out;
  }

  root.PPShipmentScope = {
    TRACK_BUTTON_SELECTOR,
    PRODUCT_LINK_SELECTOR,
    SHIPMENT_HINT_SELECTOR,
    ITEM_SCOPE_SELECTOR,
    closestItemScope,
    shipmentScope,
    collectShipmentProducts
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
