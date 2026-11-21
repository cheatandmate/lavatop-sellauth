# Lava.top x SellAuth on Cloudflare Workers

Uses SellAuth's **Custom Payment Method > Redirect to URL** and `invoices/{id}/process?mark_as_paid=true`,
and Lava's `POST /api/v3/invoice`, `GET /api/v1/invoices/{id}` and the webhook (`payment.success`).

## 0. One-click deploy
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cheatandmate/lavatop-sellauth)
The button creates a copy of the repo in your Cloudflare account, shows a form for every key below and
creates the KV namespace for you. Then skip to step 3.

**If the form does not ask for the keys:** Cloudflare builds the form from `.dev.vars.example` in the repo root.
That file starts with a dot, so it is hidden in Explorer/Finder and is easy to miss when uploading to GitHub.
Check that it is in the repo (and not empty). Either way you can always add the keys afterwards:
Worker > Settings > Variables and Secrets > Add > type **Secret** (`LAVA_API_KEY`, `LAVA_WEBHOOK_KEY`,
`LAVA_OFFER_ID`, `SELLAUTH_API_KEY`, `SELLAUTH_SHOP_ID`). Open `https://<your-worker>.workers.dev/` :
it lists any missing names.

## 1. Deploy manually (alternative)
```bash
npm install
npx wrangler deploy --dry-run >/dev/null        # KV namespace STATE is auto-created on first deploy
# edit SELLAUTH_SHOP_URL in wrangler.toml
npx wrangler secret put LAVA_API_KEY          # lava.top > Settings > API
npx wrangler secret put LAVA_WEBHOOK_KEY      # any random string (max 80 chars) you invent; same value goes into Lava (step 2)
npx wrangler secret put LAVA_OFFER_ID         # UUID of the dynamic-price offer (step 2)
npx wrangler secret put SELLAUTH_API_KEY      # SellAuth > Account > Developers (scope to this shop)
npx wrangler secret put SELLAUTH_SHOP_ID
npm test && npx wrangler deploy
```

## 2. Lava side (once)
1. Create a **product with dynamic pricing** ("Цена по запросу через API") in Lava. Copy the **offer id** (UUID
   from the product's price settings) — that is `LAVA_OFFER_ID`. The Worker charges the converted SellAuth
   invoice amount on this offer; without dynamic pricing Lava would ignore/replace `amount`.
2. In the same product's settings set the **webhook URL**: `https://<your-worker>.workers.dev/lava/callback`,
   and the **webhook API key**: paste the same value you stored as the `LAVA_WEBHOOK_KEY` secret. Lava signs
   every webhook with this key in the `X-Api-Key` header; the Worker compares it (401 otherwise).

## 3. Add the payment methods in SellAuth
Dashboard > Payment Methods > add **Redirect to URL** (needs a plan with custom payment methods). Create **separate
methods for SBP and card** — the `pay=` parameter in the URL picks the Lava method:

| Method name | Redirect URL |
|---|---|
| Оплата картой (RUB) | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=card` |
| Оплата СБП | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sbp` |
| PayPal | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=paypal` |
| PIX | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=pix` |
| Apple Pay | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=applepay` |
| iDEAL | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=ideal` |
| SEPA transfer | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=sepa` |
| Bancontact | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=bancontact` |
| Карта (USD) | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardusd` |
| Карта (EUR) | `https://<worker>/start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}&pay=cardeur` |

The methods are fixed in code — no currency settings needed:
- **`pay=card`** — invoice converted to RUB, Lava's default RUB checkout (card);
- **`pay=sbp`** — invoice converted to RUB, PAY2ME + SBP;
- **`pay=paypal`** — invoice converted to USD, PayPal;
- **`pay=pix`** — invoice converted to USD, UNLIMINT + PIX;
- **`pay=applepay`** — invoice converted to USD, UNLIMINT + APPLE_PAY;
- **`pay=ideal`** — invoice converted to EUR, UNLIMINT + IDEAL;
- **`pay=sepa`** — invoice converted to EUR, UNLIMINT + SEPATRANSFER;
- **`pay=bancontact`** — invoice converted to EUR, UNLIMINT + BANCONTACT;
- **`pay=cardusd`** — invoice converted to USD, Lava's default USD checkout (UNLIMINT + card);
- **`pay=cardeur`** — invoice converted to EUR, Lava's default EUR checkout (UNLIMINT + card);
- no `pay` parameter — USD invoice goes to PayPal, everything else to the default RUB checkout;
- an unknown `pay` value falls back to the default RUB checkout;
- BIZUM/MBWAY are not offered: Lava requires the buyer's full name and phone number, which the
  SellAuth redirect URL does not carry.

## 4. Currency and conversion
The charge currency is chosen by the payment method (RUB for card/SBP, USD for PayPal), and the
SellAuth invoice is converted when needed:
- RUB target: rate source is `cbr-xml-daily.ru` (Central Bank of Russia); USD target: `open.er-api.com`;
- rates are cached 1 h in KV; if the source is down, a cached rate up to 24 h old is used, otherwise the payment
  is **refused** (never charged at face value);
- converted amounts are rounded **up** to the next cent/kopeck; `LAVA_MARKUP_PCT` (wrangler.toml) adds an
  optional safety margin, e.g. `2` = +2%;
- delivery requires Lava to report **at least** the expected amount in the expected currency (underpayment is
  refused, overpayment never blocks delivery).

## 5. Check the invoice shape (once)
The Worker reads the price, currency and email from the SellAuth API, NOT from the URL (buyers can edit the URL).
Field names in `INVOICE` (top of `src/index.js`):
```bash
curl -s -H "Authorization: Bearer $SELLAUTH_API_KEY" \
  https://api.sellauth.com/v1/shops/$SHOP_ID/invoices/$INVOICE_ID | jq
```
If something can't be read the Worker refuses to start a payment and `npx wrangler tail` prints the keys it saw.

## Base URLs (settings in `wrangler.toml`)
| Var | Default |
|---|---|
| `LAVA_BASE_URL` | `https://gate.lava.top` |
| `SELLAUTH_BASE_URL` | `https://api.sellauth.com/v1` |
| `LAVA_PAYMENT_PROVIDER` | unset (Lava default: SMART_GLOCAL for RUB, UNLIMINT for EUR/USD) |
| `LAVA_PAYMENT_METHOD` | unset (Lava default: CARD; e.g. `SBP` for PAY2ME) |

Your own Worker address is `https://<worker-name>.<your-subdomain>.workers.dev` (enable **workers.dev** under the Worker's
Settings > Domains & Routes).

## Routes
| Route | Purpose |
|---|---|
| `GET /` | Status page: lists missing secrets, shows the deployed build |
| `GET /start?invoice=&ref=&...` | From SellAuth. Opens a Lava contract, redirects the buyer |
| `POST /lava/callback` | Lava webhook. X-Api-Key-verified, 401 if invalid |

## Test checklist
1. Place a cheap order, choose the Lava method, confirm you land on Lava's payment widget with the right amount.
2. `curl -i -X POST https://<worker>/lava/callback` must return **401**.
3. After paying, the invoice is delivered once; a webhook retry doesn't re-deliver.
4. `npx wrangler tail` while testing: conversion, settle and mismatch decisions are all logged.
Note: a refund/chargeback webhook is only logged; it cannot undo a delivery.
