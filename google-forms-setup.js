/**
 * Google Apps Script — Создание 10 Google Forms для расширения Pochtoy Parser
 *
 * Инструкция:
 * 1. Откройте script.google.com → Новый проект
 * 2. Удалите весь код в редакторе, вставьте содержимое этого файла
 * 3. Нажмите Запустить → выберите функцию createAllForms → разрешите доступ к Google Forms
 * 4. Откройте Журнал выполнения (Ctrl+Enter) — там появятся ссылки на все 10 форм
 *
 * Все формы создадутся в вашем Google Drive с правильными вопросами,
 * вариантами ответов, сообщениями после заполнения и сбором email.
 */

function createAllForms() {
  var forms = [
    createFormRegistration,
    createFormDeliveryRequest,
    createFormParsingError,
    createFormFeatureRequest,
    createFormExtensionFeedback,
    createFormAmazonIssue,
    createFormEbayIssue,
    createFormIherbIssue,
    createFormSatisfactionSurvey,
    createFormSupportRequest
  ];

  Logger.log('========================================');
  Logger.log('Создание 10 Google Forms для Pochtoy Parser');
  Logger.log('========================================\n');

  for (var i = 0; i < forms.length; i++) {
    try {
      var result = forms[i]();
      Logger.log((i + 1) + '. ' + result.title);
      Logger.log('   Редактирование: ' + result.editUrl);
      Logger.log('   Заполнение:     ' + result.publishedUrl);
      Logger.log('');
    } catch (e) {
      Logger.log((i + 1) + '. ОШИБКА: ' + e.message);
    }
  }

  Logger.log('========================================');
  Logger.log('Все формы созданы! Ссылки выше.');
  Logger.log('========================================');
}

// ─────────────────────────────────────────────
// 1. Регистрация нового пользователя
// ─────────────────────────────────────────────
function createFormRegistration() {
  var form = FormApp.create('Pochtoy Parser — Регистрация пользователя');
  form.setDescription('Заполните форму для регистрации и получения доступа к расширению Pochtoy Parser.');
  form.setConfirmationMessage('Спасибо за регистрацию! Мы свяжемся с вами в ближайшее время.');
  form.setCollectEmail(true);

  form.addTextItem()
    .setTitle('Ваше имя')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Telegram (@ или номер)')
    .setHelpText('Для оперативной связи и уведомлений')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Как вы узнали о расширении?')
    .setChoiceValues([
      'От друзей / знакомых',
      'Pochtoy.com',
      'Поиск Google',
      'Социальные сети',
      'Форумы / блоги',
      'Другое'
    ])
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Какие магазины вы используете?')
    .setChoiceValues([
      'Amazon.com',
      'eBay.com',
      'iHerb.com',
      'Другие магазины'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Как часто вы делаете заказы?')
    .setChoiceValues([
      'Несколько раз в неделю',
      'Раз в неделю',
      '1-2 раза в месяц',
      'Реже раза в месяц'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Используете ли вы Pochtoy.com для доставки?')
    .setChoiceValues(['Да', 'Нет', 'Планирую начать'])
    .setRequired(true);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 2. Заявка на доставку
// ─────────────────────────────────────────────
function createFormDeliveryRequest() {
  var form = FormApp.create('Pochtoy Parser — Заявка на доставку');
  form.setDescription('Отправьте данные о ваших заказах для оформления доставки через Pochtoy.');
  form.setConfirmationMessage('Заявка принята! Мы обработаем её в течение 1 рабочего дня.');
  form.setCollectEmail(true);

  form.addTextItem()
    .setTitle('Ваше имя / ID клиента Pochtoy')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Магазин')
    .setChoiceValues(['Amazon', 'eBay', 'iHerb', 'Другой'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Номер заказа (Order ID)')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Трек-номер (если есть)')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Список товаров')
    .setHelpText('Название, количество, цвет/размер — по одному товару на строку')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Способ доставки')
    .setChoiceValues([
      'Авиа — стандарт',
      'Авиа — экспресс',
      'Морская доставка',
      'Комбинированная'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Комментарий к заказу')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 3. Отчёт об ошибке парсинга
// ─────────────────────────────────────────────
function createFormParsingError() {
  var form = FormApp.create('Pochtoy Parser — Отчёт об ошибке парсинга');
  form.setDescription('Сообщите об ошибке при парсинге заказов. Это поможет нам улучшить расширение.');
  form.setConfirmationMessage('Спасибо за отчёт! Мы разберёмся с ошибкой в ближайшем обновлении.');
  form.setCollectEmail(true);

  form.addMultipleChoiceItem()
    .setTitle('Магазин, где возникла ошибка')
    .setChoiceValues(['Amazon', 'eBay', 'iHerb'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Версия расширения')
    .setChoiceValues([
      '6.10.x (текущая)',
      '6.9.x',
      '6.8.x',
      'Не знаю'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Тип ошибки')
    .setChoiceValues([
      'Заказы не найдены',
      'Неверное количество товаров',
      'Неправильный трек-номер',
      'Не определяется цвет/размер',
      'Пустое название товара',
      'Ошибка пагинации (не все страницы)',
      'Расширение зависает / не отвечает',
      'Другое'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Браузер')
    .setChoiceValues([
      'Google Chrome',
      'Microsoft Edge',
      'Brave',
      'Opera',
      'Другой Chromium-браузер'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Описание ошибки')
    .setHelpText('Опишите, что произошло и что вы ожидали')
    .setRequired(true);

  form.addTextItem()
    .setTitle('URL страницы, на которой возникла ошибка')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Текст ошибки из консоли (если есть)')
    .setHelpText('Откройте DevTools (F12) → Console, скопируйте ошибку')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 4. Запрос новой функции
// ─────────────────────────────────────────────
function createFormFeatureRequest() {
  var form = FormApp.create('Pochtoy Parser — Запрос новой функции');
  form.setDescription('Предложите новую функцию или улучшение для расширения.');
  form.setConfirmationMessage('Спасибо за предложение! Мы рассмотрим его при планировании следующих версий.');
  form.setCollectEmail(true);

  form.addTextItem()
    .setTitle('Название функции (кратко)')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Подробное описание')
    .setHelpText('Что должна делать функция? Какую проблему она решает?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Категория')
    .setChoiceValues([
      'Парсинг заказов',
      'Экспорт данных (CSV / Google Sheets)',
      'Автоматизация Pochtoy',
      'Интерфейс расширения',
      'Telegram-уведомления',
      'Поддержка нового магазина',
      'Другое'
    ])
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Насколько важна эта функция для вас?')
    .setBounds(1, 5)
    .setLabels('Было бы неплохо', 'Критически важно')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Есть ли аналог в других инструментах?')
    .setChoiceValues(['Да', 'Нет', 'Не знаю'])
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 5. Обратная связь по расширению
// ─────────────────────────────────────────────
function createFormExtensionFeedback() {
  var form = FormApp.create('Pochtoy Parser — Обратная связь');
  form.setDescription('Расскажите о вашем опыте использования расширения Pochtoy Parser.');
  form.setConfirmationMessage('Спасибо за обратную связь! Ваше мнение важно для нас.');
  form.setCollectEmail(true);

  form.addScaleItem()
    .setTitle('Оцените расширение в целом')
    .setBounds(1, 5)
    .setLabels('Плохо', 'Отлично')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Насколько легко было начать пользоваться?')
    .setBounds(1, 5)
    .setLabels('Очень сложно', 'Очень легко')
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Какие функции вы используете чаще всего?')
    .setChoiceValues([
      'Парсинг Amazon',
      'Парсинг eBay',
      'Парсинг iHerb',
      'Экспорт в CSV',
      'Копирование для Google Sheets',
      'Загрузка в Google Sheets',
      'Автозаполнение на Pochtoy.com',
      'Telegram-уведомления'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Что вам нравится в расширении?')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Что можно улучшить?')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Порекомендовали бы вы расширение другим?')
    .setChoiceValues([
      'Да, уже рекомендовал(а)',
      'Да, порекомендую',
      'Возможно',
      'Нет'
    ])
    .setRequired(true);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 6. Проблема с Amazon парсингом
// ─────────────────────────────────────────────
function createFormAmazonIssue() {
  var form = FormApp.create('Pochtoy Parser — Проблема с Amazon');
  form.setDescription('Детальный отчёт о проблемах с парсингом заказов Amazon.');
  form.setConfirmationMessage('Спасибо! Amazon часто меняет вёрстку — ваш отчёт поможет быстрее адаптировать парсер.');
  form.setCollectEmail(true);

  form.addMultipleChoiceItem()
    .setTitle('Тип проблемы')
    .setChoiceValues([
      'Не находит заказы на странице',
      'Не переходит на следующую страницу (пагинация)',
      'Неверный трек-номер',
      'Не определяет цвет товара',
      'Не определяет размер товара',
      'Неправильное количество (qty)',
      'Дублирование заказов',
      'Пустые строки в результатах',
      'Другое'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Домен Amazon')
    .setChoiceValues([
      'amazon.com',
      'amazon.co.uk',
      'amazon.de',
      'amazon.co.jp',
      'Другой'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Количество заказов на странице')
    .setChoiceValues([
      'Менее 10',
      '10-50',
      '50-100',
      'Более 100'
    ])
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Язык интерфейса Amazon')
    .setChoiceValues(['English', 'Deutsch', '日本語', 'Другой'])
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Подробности проблемы')
    .setHelpText('Укажите номера заказов (без персональных данных), какие данные отображаются неверно')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Скриншот (ссылка на Google Drive / Imgur)')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 7. Проблема с eBay парсингом
// ─────────────────────────────────────────────
function createFormEbayIssue() {
  var form = FormApp.create('Pochtoy Parser — Проблема с eBay');
  form.setDescription('Детальный отчёт о проблемах с парсингом заказов eBay.');
  form.setConfirmationMessage('Спасибо за отчёт! Мы проверим парсинг eBay и исправим проблему.');
  form.setCollectEmail(true);

  form.addMultipleChoiceItem()
    .setTitle('Тип проблемы')
    .setChoiceValues([
      'Не находит заказы',
      'Требуется повторный логин',
      'Неверный трек-номер',
      'Не определяет название товара',
      'Неправильное количество',
      'Ошибка при переходе между страницами',
      'Другое'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Тип покупки')
    .setChoiceValues([
      'Buy It Now',
      'Аукцион',
      'Best Offer',
      'Не помню'
    ])
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Домен eBay')
    .setChoiceValues([
      'ebay.com',
      'ebay.co.uk',
      'ebay.de',
      'Другой'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Описание проблемы')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Скриншот (ссылка)')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 8. Проблема с iHerb парсингом
// ─────────────────────────────────────────────
function createFormIherbIssue() {
  var form = FormApp.create('Pochtoy Parser — Проблема с iHerb');
  form.setDescription('Детальный отчёт о проблемах с парсингом заказов iHerb.');
  form.setConfirmationMessage('Спасибо за отчёт! Мы проверим парсинг iHerb.');
  form.setCollectEmail(true);

  form.addMultipleChoiceItem()
    .setTitle('Тип проблемы')
    .setChoiceValues([
      'Не находит заказы',
      'Неверное название товара',
      'Не определяет количество',
      'Неправильный трек-номер',
      'Проблема с авторизацией на сайте',
      'Не загружается страница заказов',
      'Другое'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Сколько заказов на iHerb вы пытались распарсить?')
    .setChoiceValues([
      '1-5',
      '5-20',
      '20-50',
      'Более 50'
    ])
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Язык интерфейса iHerb')
    .setChoiceValues(['Русский', 'English', 'Другой'])
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Описание проблемы')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Скриншот (ссылка)')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 9. Опрос удовлетворённости
// ─────────────────────────────────────────────
function createFormSatisfactionSurvey() {
  var form = FormApp.create('Pochtoy Parser — Опрос удовлетворённости');
  form.setDescription('Короткий опрос о вашем опыте использования сервиса Pochtoy и расширения Parser.');
  form.setConfirmationMessage('Спасибо за участие в опросе! Ваши ответы помогут нам стать лучше.');
  form.setCollectEmail(true);

  form.addMultipleChoiceItem()
    .setTitle('Как давно вы пользуетесь расширением?')
    .setChoiceValues([
      'Менее месяца',
      '1-3 месяца',
      '3-6 месяцев',
      '6-12 месяцев',
      'Более года'
    ])
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Оцените удобство парсинга заказов')
    .setBounds(1, 5)
    .setLabels('Неудобно', 'Очень удобно')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Оцените скорость работы расширения')
    .setBounds(1, 5)
    .setLabels('Очень медленно', 'Очень быстро')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Оцените качество экспорта данных')
    .setBounds(1, 5)
    .setLabels('Плохое', 'Отличное')
    .setRequired(true);

  form.addScaleItem()
    .setTitle('Оцените работу автозаполнения на Pochtoy.com')
    .setBounds(1, 5)
    .setLabels('Плохо', 'Отлично')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Сколько времени расширение экономит вам в месяц?')
    .setChoiceValues([
      'Менее 30 минут',
      '30 минут — 1 час',
      '1-3 часа',
      '3-5 часов',
      'Более 5 часов'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Ваши пожелания или комментарии')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}

// ─────────────────────────────────────────────
// 10. Заявка на поддержку
// ─────────────────────────────────────────────
function createFormSupportRequest() {
  var form = FormApp.create('Pochtoy Parser — Заявка на поддержку');
  form.setDescription('Опишите вашу проблему — мы поможем разобраться.');
  form.setConfirmationMessage('Заявка принята! Мы ответим на ваш email в течение 24 часов.');
  form.setCollectEmail(true);

  form.addTextItem()
    .setTitle('Ваше имя')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Тема обращения')
    .setChoiceValues([
      'Установка расширения',
      'Настройка Google Sheets',
      'Проблема с парсингом',
      'Автозаполнение Pochtoy',
      'Telegram-бот',
      'Вопрос по оплате / подписке',
      'Удаление данных',
      'Другое'
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Срочность')
    .setChoiceValues([
      'Критично — работа остановлена',
      'Высокая — мешает работе',
      'Средняя — неудобство',
      'Низкая — вопрос / предложение'
    ])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Описание проблемы')
    .setHelpText('Опишите проблему максимально подробно: что делали, что произошло, что ожидали')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Операционная система')
    .setChoiceValues([
      'Windows 10/11',
      'macOS',
      'Linux',
      'Chrome OS',
      'Другая'
    ])
    .setRequired(false);

  form.addTextItem()
    .setTitle('Версия браузера и расширения')
    .setHelpText('Chrome → Меню → О браузере; Расширение → версия в popup')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Скриншот / видео (ссылка)')
    .setRequired(false);

  return {
    title: form.getTitle(),
    editUrl: form.getEditUrl(),
    publishedUrl: form.getPublishedUrl()
  };
}
