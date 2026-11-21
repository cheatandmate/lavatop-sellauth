# Lava.top x SellAuth на Cloudflare Workers

Воркер связывает магазин на SellAuth с приёмом платежей через Lava.top.
Покупатель выбирает способ оплаты в чекауте SellAuth, воркер создаёт инвойс в Lava
на нужную сумму в нужной валюте, а после оплаты автоматически выдаёт товар.

## Как это работает

```
1. Покупатель в чекауте SellAuth нажимает кнопку способа оплаты
      → редирект на GET https://<worker>/start?invoice={id}&ref={unique_id}&...&pay=<метод>
2. Воркер читает инвойс из SellAuth API (сумма и валюта берутся оттуда, а НЕ из URL —
   покупатель мог подменить параметры), конвертирует в валюту выбранного метода
      → POST https://gate.lava.top/api/v3/invoice
      → редирект покупателя на платёжную страницу Lava
3. После оплаты Lava шлёт вебхук: POST https://<worker>/lava/callback (подпись X-Api-Key)
      → воркер перепроверяет контракт через GET /api/v1/invoices/{id}
      → если статус COMPLETED и сумма не меньше ожидаемой:
        GET SellAuth /invoices/{id}/process?mark_as_paid=true — товар выдан
4. Крон воркера (каждые 5 минут) доставляет заказы, чей вебхук потерялся
   (в течение 6 часов после создания платежа)
```

Способы оплаты фиксированы в коде и выбираются параметром `pay` в ссылке
(настройки валюты в wrangler.toml не нужны):

| `pay=` | Валюта заряда | Провайдер / метод |
|---|---|---|
| `card` | RUB | дефолтный чекаут Lava (карта) |
| `sbp` | RUB | PAY2ME + SBP |
| `paypal` | USD | PayPal |
| `pix` | USD | UNLIMINT + PIX |
| `applepay` | USD | UNLIMINT + APPLE_PAY |
| `ideal` | EUR | UNLIMINT + IDEAL |
| `sepa` | EUR | UNLIMINT + SEPATRANSFER |
| `bancontact` | EUR | UNLIMINT + BANCONTACT |
| `cardusd` | USD | дефолтный чекаут Lava в USD (UNLIMINT + карта) |
| `cardeur` | EUR | дефолтный чекаут Lava в EUR (UNLIMINT + карта) |
| *(без `pay`)* | — | USD-инвойс → PayPal; остальные → дефолтный RUB-чекаут |

BIZUM и MB WAY не поддерживаются: Lava требует имя и телефон покупателя
(`walletId`) при создании инвойса, а SellAuth в redirect-ссылке их не передаёт.

---

## Шаг 1. Деплой воркера

### Вариант А — кнопкой (рекомендую)

1. Нажми кнопку — Cloudflare скопирует репозиторий и предложит форму:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cheatandmate/lavatop-sellauth)

2. В форме заполни значения секретов (таблица «Где взять ключи» — шаг 2 ниже).
   Если форма **не** спросила ключи: Worker → Settings → Variables and Secrets →
   Add → тип **Secret** → добавь пять ключей из таблицы (после добавления redeploy не нужен).
3. Дождись сборки (Deployments). При успехе открой `https://<worker>.workers.dev/` —
   должна появиться строка `Lava x SellAuth bridge is running. build 2026-11-21.2`,
   либо список недостающих секретов со статусом 503.

Возможные ошибки сборки и что делать:

| Ошибка в билде | Причина / решение |
|---|---|
| `The entry-point file at "src/index.js" was not found` | в репозитории нет папки `src` — залей `src/index.js` через Add file → Upload files (имя файла указывай как `src/index.js`) |
| `Cannot retry a build that was created with a seed_repo override` | кнопка Retry для первого билда не работает — просто запушь коммит в репо, сборка запустится сама |
| `a namespace with this account ID and title already exists [code: 10014]` | KV-неймспейс уже создан предыдущей попыткой — открой Storage & Databases → KV, скопируй Namespace ID и впиши его в `wrangler.toml` в блок `[[kv_namespaces]]` строкой `id = "<ID>"`, закоммить |

### Вариант Б — вручную через терминал

```bash
npm install
npx wrangler login                                          # логин в Cloudflare (браузер откроется)
npx wrangler kv namespace create STATE                      # скопируй id из вывода в wrangler.toml
# отредактируй SELLAUTH_SHOP_URL в wrangler.toml
npx wrangler secret put LAVA_API_KEY                        # значения — см. таблицу в шаге 2
npx wrangler secret put LAVA_WEBHOOK_KEY
npx wrangler secret put LAVA_OFFER_ID
npx wrangler secret put SELLAUTH_API_KEY
npx wrangler secret put SELLAUTH_SHOP_ID
npm test                                                    # проверка кода
npx wrangler deploy
```

---

## Шаг 2. Где взять каждый ключ

Все пять ключей добавляются как **Secret** (Worker → Settings → Variables and Secrets → Add → Secret).
Значения нигде не публикуются и при деплоях не сбрасываются.

| Секрет | Где взять | Пример вида |
|---|---|---|
| `LAVA_API_KEY` | app.lava.top → **Интеграции** → вкладка **API** → «+ Создать API key». Ключ для запросов к Lava из воркера | длинная строка |
| `LAVA_WEBHOOK_KEY` | **Придумываешь сам**: любая случайная строка до 80 символов. Вставь её (а) в настройки вебхука в Lava (шаг 3.3) и (б) в этот секрет | `openssl rand -hex 32` в Git Bash |
| `LAVA_OFFER_ID` | UUID оффера с динамической ценой — см. шаг 3.2 | `73c38598-28d4-...` |
| `SELLAUTH_API_KEY` | dash.sellauth.com → **Account → Developers** → Create API Key, привязать к конкретному магазину. Достаточно прав: чтение инвойсов + процессинг | — |
| `SELLAUTH_SHOP_ID` | Числовой ID магазина из адреса API (`/v1/shops/`**`42`**`/...`) | `42` |

В `wrangler.toml` (не секрет, обычная переменная) — `SELLAUTH_SHOP_URL`: адрес твоего
магазина, например `https://cheatandmate.com` — туда воркер возвращает покупателя после оплаты.

---

## Шаг 3. Настройка Lava (один раз)

### 3.1. Продукт с динамической ценой

1. app.lava.top → **Продукты** → **Создать** → тип «Цифровой продукт».
2. В настройках цены выбери **«Цена по запросу через API»** (динамическая цена) —
   без этого Lava проигнорирует сумму, которую передаёт воркер, и возьмёт цену оффера.
3. Название продукта видит покупатель на платёжной странице — сделай нейтральное
   («Оплата заказа»), а не конкретный товар. Один продукт обслуживает ВСЕ товары магазина.
4. Опубликуй продукт.

### 3.2. Получить offerId

```powershell
$h = @{ "X-Api-Key" = "ВАШ_LAVA_API_KEY" }
$r = Invoke-RestMethod -Uri "https://gate.lava.top/api/v2/products?feedVisibility=ALL" -Headers $h
$r.items | ForEach-Object {
  $p = $_.data; if (-not $p.id) { $p = $_ }    # API возвращает продукт и в .data, и напрямую
  if ($p.offers) {
    "product: " + $p.title + "  (id " + $p.id + ")"
    $p.offers | ForEach-Object { "  offerId: " + $_.id + "  (" + $_.name + ")" }
  }
}
```

`feedVisibility=ALL` нужен, чтобы увидеть ещё не опубликованные продукты.
Нужен `offers[].id` (НЕ id продукта) → это значение секрета `LAVA_OFFER_ID`.

### 3.3. Вебхук

Интеграции → API → **«Добавить Webhook»**:

- **URL**: `https://<worker>.workers.dev/lava/callback` (обязательно с `https://`);
- **Тип события**: «Успешная оплата» (обязательно), «Неуспешная оплата» (полезно), чарджбек — по желанию;
- **Вид аутентификации**: **«API key вашего сервиса»** — НЕ Basic;
- **API key**: та же строка, что лежит в секрете `LAVA_WEBHOOK_KEY`;
- Комментарий — любой.

Lava будет передавать этот ключ в заголовке `X-Api-Key`; воркер сверяет его и
отвечает 401 на всё чужое. Если ключи не совпадут — в логе будет
`callback REJECTED (401): X-Api-Key present = true`.

### 3.4. Методы продаж

«Методы продаж» / «Интеграции → API»: включи те способы, которые будешь раздавать
(PAY2ME: СБП/карта, PayPal, UNLIMINT: PIX/Apple Pay/iDEAL/SEPA/Bancontact).

⚠️ Лимиты сумм у Lava на валюту (например, для USD — **от 5 до 10 000**).
Если покупатель выбрал метод, а сконвертированная сумма вне лимитов, он увидит
сообщение с точным диапазоном. Для дешёвых PayPal/PIX-товаров ставь цену от $5.

---

## Шаг 4. Кнопки в SellAuth

Dashboard → **Payment Methods** → **Add → Redirect to URL**. Одна кнопка = один способ.
Включай только те, что включены в Lava (шаг 3.4). Подставь свой домен воркера:

| Название кнопки | URL | Ограничить валютой (если SellAuth позволяет) |
|---|---|---|
| Оплата картой (RUB) | `https://<worker>.workers.dev/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=card` | RUB |
| Оплата СБП | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sbp` | RUB |
| PayPal | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=paypal` | USD |
| PIX | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=pix` | — |
| Apple Pay | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=applepay` | — |
| iDEAL | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=ideal` | — |
| SEPA transfer | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sepa` | — |
| Bancontact | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=bancontact` | — |
| Карта (USD) | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardusd` | — |
| Карта (EUR) | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardeur` | — |

Важно: `{id}`, `{unique_id}`, `{price}`, `{currency}`, `{email}` — плейсхолдеры SellAuth,
не заменяй их. Ссылку вставляй одной строкой без переносов. Выбор метода происходит
в чекауте SellAuth; на платёжной странице Lava метод уже зафиксирован.

---

## Шаг 5. Валюты и конвертация

- Инвойс SellAuth конвертируется в валюту выбранного метода: RUB — курс ЦБ РФ
  (`cbr-xml-daily.ru`), USD/EUR — `open.er-api.com`. Кэш курса 1 час; если источник
  недоступен — берётся курс не старше 24 часов; если и его нет — оплата **отклоняется**
  (никогда не бьём по цене «на глаз»).
- Суммы после конвертации округляются **вверх** до копейки/цента.
  `LAVA_MARKUP_PCT` в wrangler.toml добавляет запас: `2` = +2%.
- Доставка требует, чтобы Lava подтвердила **не меньше** ожидаемой суммы в ожидаемой
  валюте: недоплата — отказ, переплата — доставляем.

---

## Шаг 6. Проверка

1. Дешёвый заказ → кнопка метода → должен открыться виджет Lava на правильную сумму/валюту.
2. `curl.exe -i -X POST https://<worker>.workers.dev/lava/callback` → должен вернуть **401**
   (проверка подписи; Lava сама тестирует это при добавлении вебхука).
3. Оплати → инвойс в SellAuth становится completed, товары выданы **один раз**
   (повторные вебхуки и крон не задваивают).
4. Во время теста держи `npx wrangler tail --format pretty` — там видны:
   `convert ... -> RUB`, `settle ... COMPLETED`, `SellAuth invoice processed <id>`.

---

## Диагностика проблем

| Симптом | Что смотреть / делать |
|---|---|
| Страница `/` говорит `Missing: ...` | добавь перечисленные секреты |
| Покупателю «Could not start payment.» | ищи в логе строку `lava error POST /api/v3/invoice 400 {...}` — там точная причина от Lava |
| `Amount=... not in allowed limits=(5, 10000) for USD` | сумма вне лимитов Lava для этой валюты — покупатель видит это сообщение сам |
| `callback REJECTED (401)` | ключ вебхука в Lava ≠ секрет `LAVA_WEBHOOK_KEY` — сверь значения |
| PIX даёт 403 от `api.billygate.com` | PIX не активирован на стороне Lava/PSP — тикет в поддержку Lava, воркер не при чём (проверено: и USD+PIX, и EUR+PIX дают 403) |
| Вебхук не приходит | «История Webhooks» в Lava; крон доставит пропущенное в течение 6 часов |
| В PowerShell `curl -s` ругается | это alias Invoke-WebRequest — используй `curl.exe -s` |

Роуты воркера: `GET /` (статус), `GET /start` (от SellAuth), `POST /lava/callback` (вебхук Lava).
Базовые URL: `https://gate.lava.top`, `https://api.sellauth.com/v1` (менять не нужно).
