# Lava.top x SellAuth on Cloudflare Workers

🌐 **English** (below) | 🇷🇺 **Русский** (ниже, после разделителя)

---

## Part 1 — English

A Worker that connects a SellAuth store to Lava.top payments.
The buyer picks a payment method in the SellAuth checkout, the Worker creates a Lava
invoice for the right amount in the right currency, and after payment the goods are
delivered automatically.

### How it works

```
1. The buyer clicks a payment method button in the SellAuth checkout
      → redirect to GET https://<worker>/start?invoice={id}&ref={unique_id}&...&pay=<method>
2. The Worker reads the invoice from the SellAuth API (amount and currency come from
   there, NOT from the URL — the buyer could tamper with parameters), converts the
   amount to the currency of the chosen method
      → POST https://gate.lava.top/api/v3/invoice
      → the buyer is redirected to the Lava payment page
3. After payment Lava sends a webhook: POST https://<worker>/lava/callback (X-Api-Key signature)
      → the Worker re-checks the contract via GET /api/v1/invoices/{id}
      → if the status is COMPLETED and the amount is at least the expected one:
        GET SellAuth /invoices/{id}/process?mark_as_paid=true — goods delivered
4. The Worker's cron (every 5 minutes) delivers orders whose webhook was lost
   (within 6 hours of payment creation)
```

Payment methods are fixed in code and selected by the `pay` parameter in the link
(no currency settings in wrangler.toml needed):

| `pay=` | Charge currency | Provider / method |
|---|---|---|
| `card` | RUB | Lava's default RUB checkout (card) |
| `sbp` | RUB | PAY2ME + SBP |
| `paypal` | USD | PayPal |
| `pix` | USD | UNLIMINT + PIX |
| `applepay` | USD | UNLIMINT + APPLE_PAY |
| `ideal` | EUR | UNLIMINT + IDEAL |
| `sepa` | EUR | UNLIMINT + SEPATRANSFER |
| `bancontact` | EUR | UNLIMINT + BANCONTACT |
| `cardusd` | USD | Lava's default USD checkout (UNLIMINT + card) |
| `cardeur` | EUR | Lava's default EUR checkout (UNLIMINT + card) |
| *(no `pay`)* | — | USD invoice → PayPal; everything else → default RUB checkout |

BIZUM and MB WAY are not supported: Lava requires the buyer's full name and phone
(`walletId`) at invoice creation, and the SellAuth redirect URL does not carry them.

---

### Step 1. Deploy the Worker

#### Option A — one-click button (recommended)

1. Click the button — Cloudflare copies the repository and shows a form:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cheatandmate/lavatop-sellauth)

2. Fill in the secrets in the form (see the "Where to get each key" table — Step 2).
   If the form **does not** ask for the keys: Worker → Settings → Variables and Secrets →
   Add → type **Secret** → add the five keys from the table (no redeploy needed after that).
3. Wait for the build (Deployments). On success open `https://<worker>.workers.dev/` —
   you should see `Lava x SellAuth bridge is running. build 2026-11-21.2`,
   or a list of missing secrets with status 503.

Build errors and fixes:

| Build error | Cause / fix |
|---|---|
| `The entry-point file at "src/index.js" was not found` | the repo has no `src` folder — upload `src/index.js` via Add file → Upload files (enter the file name as `src/index.js`) |
| `Cannot retry a build that was created with a seed_repo override` | the first build's Retry button doesn't work — just push a commit to the repo, a new build starts automatically |
| `a namespace with this account ID and title already exists [code: 10014]` | the KV namespace was already created by a previous attempt — open Storage & Databases → KV, copy the Namespace ID and add it to `wrangler.toml` in the `[[kv_namespaces]]` block as `id = "<ID>"`, then commit |

#### Option B — manual, via terminal

```bash
npm install
npx wrangler login                                          # log in to Cloudflare (opens a browser)
npx wrangler kv namespace create STATE                      # copy the id from the output into wrangler.toml
# edit SELLAUTH_SHOP_URL in wrangler.toml
npx wrangler secret put LAVA_API_KEY                        # values — see the table in Step 2
npx wrangler secret put LAVA_WEBHOOK_KEY
npx wrangler secret put LAVA_OFFER_ID
npx wrangler secret put SELLAUTH_API_KEY
npx wrangler secret put SELLAUTH_SHOP_ID
npm test                                                    # code check
npx wrangler deploy
```

---

### Step 2. Where to get each key

All five keys go in as **Secret** (Worker → Settings → Variables and Secrets → Add → Secret).
They are never published anywhere and are not reset by deploys.

| Secret | Where to get it | Looks like |
|---|---|---|
| `LAVA_API_KEY` | app.lava.top → **Интеграции** → **API** tab → «+ Создать API key». The key the Worker uses for requests to Lava | long string |
| `LAVA_WEBHOOK_KEY` | **You invent it**: any random string up to 80 characters. Put the same string (a) in the webhook settings in Lava (Step 3.3) and (b) in this secret | `openssl rand -hex 32` in Git Bash |
| `LAVA_OFFER_ID` | UUID of the dynamic-price offer — see Step 3.2 | `73c38598-28d4-...` |
| `SELLAUTH_API_KEY` | dash.sellauth.com → **Account → Developers** → Create API Key, scoped to this shop. Enough permissions: read invoices + process them | — |
| `SELLAUTH_SHOP_ID` | Numeric shop ID from the API address (`/v1/shops/`**`42`**`/...`) | `42` |

In `wrangler.toml` (not a secret, a plain variable) — `SELLAUTH_SHOP_URL`: your store's
address, e.g. `https://cheatandmate.com` — the Worker sends the buyer back there after payment.

---

### Step 3. Lava setup (once)

#### 3.1. Product with dynamic pricing

1. app.lava.top → **Продукты** → **Создать** → type "Digital product".
2. In the price settings choose **«Цена по запросу через API»** (dynamic pricing) —
   otherwise Lava ignores the amount the Worker sends and uses the offer's fixed price.
3. The product title is visible to the buyer on the payment page — make it neutral
   ("Order payment"), not a specific product. ONE product serves ALL products of the store.
4. Publish the product.

#### 3.2. Get the offerId

```powershell
$h = @{ "X-Api-Key" = "YOUR_LAVA_API_KEY" }
$r = Invoke-RestMethod -Uri "https://gate.lava.top/api/v2/products?feedVisibility=ALL" -Headers $h
$r.items | ForEach-Object {
  $p = $_.data; if (-not $p.id) { $p = $_ }    # the API returns the product both in .data and directly
  if ($p.offers) {
    "product: " + $p.title + "  (id " + $p.id + ")"
    $p.offers | ForEach-Object { "  offerId: " + $_.id + "  (" + $_.name + ")" }
  }
}
```

`feedVisibility=ALL` is needed to see unpublished (draft) products.
You need `offers[].id` (NOT the product id) → that value is the `LAVA_OFFER_ID` secret.

#### 3.3. Webhook

Интеграции → API → **«Добавить Webhook»**:

- **URL**: `https://<worker>.workers.dev/lava/callback` (must include `https://`);
- **Event type**: "Успешная оплата" (required), "Неуспешная оплата" (useful), chargeback — optional;
- **Authentication**: **«API key вашего сервиса»** — NOT Basic;
- **API key**: the same string as in the `LAVA_WEBHOOK_KEY` secret;
- Comment — anything.

Lava sends that key in the `X-Api-Key` header; the Worker compares it and answers
401 to anything else. If the keys don't match you'll see
`callback REJECTED (401): X-Api-Key present = true` in the log.

#### 3.4. Sales methods

«Методы продаж» / «Интеграции → API»: enable the methods you plan to offer
(PAY2ME: SBP/card, PayPal, UNLIMINT: PIX/Apple Pay/iDEAL/SEPA/Bancontact).

⚠️ Lava has per-currency amount limits (for USD — **5 to 10 000**). If a buyer picks
a method and the converted amount is outside the limits, they see a message with the
exact range. For cheap PayPal/PIX products set the price from $5.

---

### Step 4. Buttons in SellAuth

Dashboard → **Payment Methods** → **Add → Redirect to URL**. One button = one method.
Enable only those that are enabled in Lava (Step 3.4). Put your Worker domain in:

| Button name | URL | Restrict by currency (if SellAuth allows) |
|---|---|---|
| Card (RUB) | `https://<worker>.workers.dev/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=card` | RUB |
| SBP | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sbp` | RUB |
| PayPal | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=paypal` | USD |
| PIX | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=pix` | — |
| Apple Pay | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=applepay` | — |
| iDEAL | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=ideal` | — |
| SEPA transfer | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sepa` | — |
| Bancontact | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=bancontact` | — |
| Card (USD) | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardusd` | — |
| Card (EUR) | `...start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardeur` | — |

Important: `{id}`, `{unique_id}`, `{price}`, `{currency}`, `{email}` are SellAuth
placeholders — do not replace them. Paste the link as one line without line breaks.
The method is chosen in the SellAuth checkout; on the Lava payment page it is already fixed.

---

### Step 5. Currencies and conversion

- The SellAuth invoice is converted into the currency of the chosen method: RUB —
  Central Bank of Russia rate (`cbr-xml-daily.ru`), USD/EUR — `open.er-api.com`.
  The rate is cached 1 hour; if the source is down a rate up to 24 hours old is used;
  if there is none the payment is **refused** (never charged at a made-up price).
- Converted amounts are rounded **up** to the next cent/kopeck.
  `LAVA_MARKUP_PCT` in wrangler.toml adds a margin: `2` = +2%.
- Delivery requires Lava to confirm **at least** the expected amount in the expected
  currency: underpayment — refused, overpayment — delivered.

---

### Step 6. Testing

1. A cheap order → the method button → the Lava widget opens with the right amount/currency.
2. `curl.exe -i -X POST https://<worker>.workers.dev/lava/callback` → must return **401**
   (signature check; Lava itself tests this when you add the webhook).
3. Pay → the SellAuth invoice becomes completed, goods delivered **once**
   (duplicate webhooks and the cron do not double-deliver).
4. During the test keep `npx wrangler tail --format pretty` running — you'll see:
   `convert ... → RUB`, `settle ... COMPLETED`, `SellAuth invoice processed <id>`.

---

### Troubleshooting

| Symptom | What to look at / do |
|---|---|
| The `/` page says `Missing: ...` | add the listed secrets |
| Buyer sees "Could not start payment." | find the `lava error POST /api/v3/invoice 400 {...}` line in the log — the exact reason from Lava is there |
| `Amount=... not in allowed limits=(5, 10000) for USD` | the amount is outside Lava's limits for that currency — the buyer sees this message themselves |
| `callback REJECTED (401)` | the webhook key in Lava ≠ the `LAVA_WEBHOOK_KEY` secret — compare the values |
| PIX gives 403 from `api.billygate.com` | PIX is not activated on the Lava/PSP side — ticket to Lava support, the Worker is not at fault (verified: both USD+PIX and EUR+PIX give 403) |
| Webhook never arrives | "История Webhooks" in Lava; the cron delivers anything missed within 6 hours |
| In PowerShell `curl -s` complains | it's an Invoke-WebRequest alias — use `curl.exe -s` |

Worker routes: `GET /` (status), `GET /start` (from SellAuth), `POST /lava/callback` (Lava webhook).
Base URLs: `https://gate.lava.top`, `https://api.sellauth.com/v1` (no need to change).

---
---

# Часть 2 — Русский

Воркер, связывающий магазин на SellAuth с приёмом платежей через Lava.top.
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
