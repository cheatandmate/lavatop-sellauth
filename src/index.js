/* =====================================================================
 * Lava.top  <->  SellAuth bridge for Cloudflare Workers
 *
 *   1. SellAuth "Redirect to URL" custom payment method sends the buyer to
 *        GET /start?invoice={id}&ref={unique_id}&amount={price}&currency={currency}&email={email}
 *      The amount/currency in that URL are buyer-editable and are NOT trusted:
 *      the Worker reads the invoice from the SellAuth API by id. If the invoice
 *      currency differs from LAVA_CURRENCY (default RUB), the amount is
 *      converted at a daily reference rate (+ optional markup), rounded UP.
 *   2. Worker creates a Lava contract (POST /api/v3/invoice, needs an offer
 *      with dynamic pricing) and redirects the buyer to the payment widget.
 *   3. Lava calls  POST /lava/callback  (webhook URL set in the Lava product
 *      settings). The callback carries an X-Api-Key header, which must equal
 *      the webhook key YOU generated and shared with Lava. The Worker then
 *      re-checks the contract with GET /api/v1/invoices/{id} before delivering.
 *   4. Delivery = SellAuth  GET /invoices/{id}/process?mark_as_paid=true
 *   5. Cron (every 5 min) re-checks pending payments in case a webhook is lost.
 * ===================================================================== */

// ---- SellAuth invoice field mapping ---------------------------------
// Verified against a real SellAuth invoice: id, status ("pending" | "completed" |
// "cancelled"), price (string, e.g. "1.00"), currency, email, unique_id.
const INVOICE = {
  amount: (i) => i.price ?? i.total ?? i.amount ?? i.total_price,
  currency: (i) => i.currency,
  email: (i) => i.email ?? i.customer_email ?? i.customer?.email,
  status: (i) => i.status,
  doneStatuses: ["completed", "paid", "processed", "delivered"],
  deadStatuses: ["cancelled", "canceled"], // SellAuth cancels stale pending invoices itself
};
// ---------------------------------------------------------------------

// Lava contract statuses. POST /api/v3/invoice returns lowercase
// (new/in-progress/...), GET /api/v1/invoices/{id} returns uppercase
// (NEW/IN_PROGRESS/COMPLETED/FAILED) -- everything is normalized to upper.
const ALIVE_STATUSES = ["NEW", "IN_PROGRESS"];
const DONE_STATUSES = ["COMPLETED"];
const DEAD_STATUSES = ["FAILED", "CANCELLED", "CANCELLED_SUBSCRIPTION", "EXPIRED"];

// Shown on GET / so you can confirm which code is actually deployed.
const BUILD = "2026-11-21.2";

const DEFAULT_LAVA_BASE = "https://gate.lava.top";
const DEFAULT_SELLAUTH_BASE = "https://api.sellauth.com/v1";
const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const trimSlash = (u) => u.replace(/\/+$/, "");
const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const validId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const validUuid = (s) => typeof s === "string" && /^[0-9a-fA-F-]{8,64}$/.test(s);
const money = (n) => Number(n).toFixed(2);
// Round UP to the next cent/kopeck, ignoring float noise.
const ceil2 = (x) => Math.ceil(Math.round(x * 100 * 1e4) / 1e4) / 100;

/* ----------------------- Currency conversion ---------------------- */

// `to` per 1 unit of `from`. RUB comes from the Central Bank of Russia,
// other currencies from open.er-api.com (keyless). Cached 1h in KV; if the
// source is unreachable a cached rate up to 24h old is used; otherwise null.
async function rateTo(env, from, to) {
  if (from === to) return 1;
  const key = `rate:${from}:${to}`;
  const cached = await env.STATE.get(key, "json");
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.rate;
  let ok = false;
  try {
    let rate = NaN;
    if (to === "RUB") {
      const res = await fetch(env.CBR_URL || CBR_URL, { headers: { Accept: "application/json" } });
      const v = (await res.json())?.Valute?.[from];
      rate = Number(v?.Value) / Number(v?.Nominal || 1);
      ok = res.ok;
    } else {
      const res = await fetch(`https://open.er-api.com/v6/latest/${to}`, { headers: { Accept: "application/json" } });
      const j = await res.json();
      const per = j?.rates?.[from];
      rate = per ? 1 / Number(per) : NaN;
      ok = res.ok && j?.result === "success";
    }
    if (ok && isFinite(rate) && rate > 0) {
      await env.STATE.put(key, JSON.stringify({ rate, ts: Date.now() }), { expirationTtl: 60 * 60 * 24 });
      return rate;
    }
    console.log("FX rate unusable for", from, "->", to);
  } catch (e) {
    console.log("FX fetch failed", String(e));
  }
  return cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000 ? cached.rate : null; // stale beats nothing
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------ Lava ------------------------------ */

async function lava(env, method, path, body) {
  const res = await fetch(trimSlash(env.LAVA_BASE_URL || DEFAULT_LAVA_BASE) + path, {
    method,
    headers: {
      "X-Api-Key": env.LAVA_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok || !json) {
    console.log("lava error", method, path, res.status, raw.slice(0, 500));
    const err = new Error(`Lava ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.detail = (json && json.error) || raw.slice(0, 200); // e.g. "Amount=3.99 not in allowed limits=(5, 10000) for USD"
    throw err;
  }
  return json;
}

// Webhook authenticity: Lava signs its calls with the webhook key YOU generated
// and shared with them (plain X-Api-Key header, no HMAC). Never authorize when
// either side is empty.
export function verifyCallback(env, request) {
  const key = request.headers.get("X-Api-Key");
  if (!key || !env.LAVA_WEBHOOK_KEY) return false;
  return safeEqual(key, env.LAVA_WEBHOOK_KEY);
}

/* ------------------------- Configuration self-check ------------------------ */

const REQUIRED = ["LAVA_API_KEY", "LAVA_WEBHOOK_KEY", "LAVA_OFFER_ID", "SELLAUTH_API_KEY", "SELLAUTH_SHOP_ID"];
// Names only, never values. Template placeholders ("your-...") count as missing.
export function missingConfig(env) {
  const m = REQUIRED.filter((k) => !env[k] || /^your-/i.test(String(env[k]).trim()));
  if (!env.STATE) m.push("STATE (KV binding)");
  return m;
}
const shopUrlIsPlaceholder = (env) => !env.SELLAUTH_SHOP_URL || /YOURSHOP/i.test(env.SELLAUTH_SHOP_URL);

/* ----------------------------- SellAuth ----------------------------- */

async function sellauth(env, path) {
  const res = await fetch(`${trimSlash(env.SELLAUTH_BASE_URL || DEFAULT_SELLAUTH_BASE)}/shops/${env.SELLAUTH_SHOP_ID}${path}`, {
    headers: { Authorization: `Bearer ${env.SELLAUTH_API_KEY}`, Accept: "application/json" },
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok) {
    console.log("sellauth error", path, res.status, raw.slice(0, 500));
    throw new Error(`SellAuth ${path} failed (${res.status})`);
  }
  return json;
}
const getInvoice = async (env, id) => {
  const j = await sellauth(env, `/invoices/${encodeURIComponent(id)}`);
  return j?.data ?? j;
};
const processInvoice = (env, id) =>
  sellauth(env, `/invoices/${encodeURIComponent(id)}/process?mark_as_paid=true`);

/* ------------------------------ Routes ------------------------------ */

// GET /start?invoice=&ref=...  ->  302 to the Lava payment widget
async function handleStart(env, request) {
  const q = new URL(request.url).searchParams;
  const invoiceId = q.get("invoice");
  const ref = q.get("ref");
  if (!validId(invoiceId)) return text("Bad invoice id", 400);

  const back = validId(ref) && env.SELLAUTH_SHOP_URL
    ? `${env.SELLAUTH_SHOP_URL.replace(/\/$/, "")}/checkout/${ref}`
    : new URL(request.url).origin;
  const fallback = back;

  // Existing payment for this invoice? Refresh its status first (delivers a
  // missed webhook and detects failed contracts) instead of blindly redirecting
  // the buyer to a widget that may already be dead.
  const existing = await env.STATE.get(`inv:${invoiceId}`, "json");
  if (existing?.delivered) return Response.redirect(fallback, 302);
  if (existing?.contractId) {
    try { await settle(env, existing.contractId); }
    catch (e) { console.log("reuse check failed", invoiceId, String(e)); }
    const rec = await env.STATE.get(`inv:${invoiceId}`, "json");
    if (rec?.delivered) return Response.redirect(fallback, 302);
    if (rec?.payment_url && ALIVE_STATUSES.includes(String(rec.status ?? "").toUpperCase())) {
      return Response.redirect(rec.payment_url, 302);
    }
    // failed/expired (or unknown state): fall through and create a new contract
  }

  // Amount and currency come from SellAuth, never from the URL.
  const invoice = await getInvoice(env, invoiceId);
  const amountRaw = INVOICE.amount(invoice);
  const currency = String(INVOICE.currency(invoice) ?? "").toUpperCase();
  if (amountRaw == null || isNaN(Number(amountRaw)) || !currency) {
    console.log("Could not read amount/currency from invoice. Keys:", Object.keys(invoice || {}).join(","));
    return text("Invoice could not be read.", 502);
  }
  const st = String(INVOICE.status(invoice) ?? "").toLowerCase();
  if (INVOICE.doneStatuses.includes(st) || INVOICE.deadStatuses.includes(st)) {
    console.log("invoice not payable, status:", st, invoiceId);
    return Response.redirect(fallback, 302); // SellAuth's checkout page shows the real state
  }
  // Method selection via the `pay` parameter of the SellAuth redirect URL
  // (all routes Lava's public API offers; European methods charge in EUR):
  //   pay=card       -> RUB, Lava's default RUB checkout (card)
  //   pay=sbp        -> RUB, PAY2ME + SBP
  //   pay=paypal     -> USD, PayPal
  //   pay=pix        -> USD, UNLIMINT + PIX
  //   pay=applepay   -> USD, UNLIMINT + APPLE_PAY
  //   pay=ideal      -> EUR, UNLIMINT + IDEAL
  //   pay=sepa       -> EUR, UNLIMINT + SEPATRANSFER
  //   pay=bancontact -> EUR, UNLIMINT + BANCONTACT
  //   pay=cardusd    -> USD, Lava's default USD checkout (UNLIMINT + card)
  //   pay=cardeur    -> EUR, Lava's default EUR checkout (UNLIMINT + card)
  // BIZUM/MBWAY are not offered: Lava requires the buyer's full name and
  // phone (walletId), which the SellAuth redirect URL does not carry.
  // Without `pay`: USD invoices go to PayPal, everything else to the default
  // RUB checkout. Amounts always come from SellAuth, never the URL.
  const METHODS = Object.assign(Object.create(null), {
    card:       { target: "RUB" },
    sbp:        { target: "RUB", provider: "PAY2ME", method: "SBP" },
    paypal:     { target: "USD", provider: "PAYPAL" },
    pix:        { target: "USD", provider: "UNLIMINT", method: "PIX" },
    applepay:   { target: "USD", provider: "UNLIMINT", method: "APPLE_PAY" },
    ideal:      { target: "EUR", provider: "UNLIMINT", method: "IDEAL" },
    sepa:       { target: "EUR", provider: "UNLIMINT", method: "SEPATRANSFER" },
    bancontact: { target: "EUR", provider: "UNLIMINT", method: "BANCONTACT" },
    cardusd:    { target: "USD" }, // provider/method unset: Lava's default USD checkout
    cardeur:    { target: "EUR" }, // provider/method unset: Lava's default EUR checkout
  });
  const pay = (q.get("pay") || "").trim().toLowerCase();
  let target;
  let provider;
  let method;
  if (Object.hasOwn(METHODS, pay)) {
    ({ target, provider, method } = METHODS[pay]);
  } else if (pay === "") {
    if (currency === "USD") { target = "USD"; provider = "PAYPAL"; } // Lava's USD providers: UNLIMINT/PAYPAL
    else target = "RUB"; // Lava's default RUB checkout (card)
  } else {
    console.log("unknown pay param, falling back to the default RUB checkout:", pay, invoiceId);
    target = "RUB"; // Lava's default RUB checkout (card)
  }

  let amount = money(amountRaw);
  let rate = 1;
  if (currency !== target) {
    rate = await rateTo(env, currency, target);
    if (!rate) return text("Exchange rate unavailable, please try again later.", 502);
    const markup = 1 + Number(env.LAVA_MARKUP_PCT || 0) / 100;
    amount = money(ceil2(Number(amountRaw) * rate * markup));
    console.log("convert", invoiceId, `${money(amountRaw)} ${currency}`, "x", rate, "->", `${amount} ${target}`);
  }

  // Do not send `id`: Lava generates the contract id itself. `amount` requires
  // an offer published with dynamic pricing ("Цена по запросу через API").
  const body = {
    email: String(INVOICE.email(invoice) ?? q.get("email") ?? "buyer@example.com").slice(0, 256),
    offerId: env.LAVA_OFFER_ID,
    currency: target,
    amount: Number(amount),
    successful_return_url: back,
    failure_return_url: back,
    cancel_return_url: back,
  };
  if (provider) body.paymentProvider = provider;
  if (method) body.paymentMethod = method;
  const tx = await lava(env, "POST", "/api/v3/invoice", body);
  if (!tx.id || !tx.paymentUrl) {
    console.log("Unexpected Lava response", JSON.stringify(tx).slice(0, 500));
    return text("Could not start payment.", 502);
  }

  const ttl = { expirationTtl: 60 * 60 * 24 * 30 };
  await env.STATE.put(
    `inv:${invoiceId}`,
    JSON.stringify({ contractId: tx.id, payment_url: tx.paymentUrl, amount, currency: target, orig: `${money(amountRaw)} ${currency}`, rate, status: String(tx.status ?? "").toUpperCase(), delivered: false, created: Date.now() }),
    ttl
  );
  await env.STATE.put(`tx:${tx.id}`, String(invoiceId), ttl);
  await env.STATE.put(`pending:${invoiceId}`, "1", { expirationTtl: 60 * 60 * 6 });
  return Response.redirect(tx.paymentUrl, 302);
}

// Everything needed is re-read from Lava (authenticated with YOUR key) and
// SellAuth, so correctness does not depend on KV, which is only eventually
// consistent across regions.
async function settle(env, contractId) {
  const invoiceId = await env.STATE.get(`tx:${contractId}`);
  if (!invoiceId) {
    console.log("UNKNOWN contract (no KV mapping):", contractId);
    return { ok: false, reason: "unknown contract" };
  }
  const rec = (await env.STATE.get(`inv:${invoiceId}`, "json")) ?? {};
  if (rec.delivered) return { ok: true, reason: "already delivered" };

  const s = await lava(env, "GET", `/api/v1/invoices/${encodeURIComponent(contractId)}`);
  const lavaStatus = String(s.status ?? "").toUpperCase();
  rec.status = lavaStatus;
  const ttl = { expirationTtl: 60 * 60 * 24 * 30 };
  console.log("settle", invoiceId, "contract", contractId, "| Lava status:", lavaStatus, "| expected", rec.amount, rec.currency, "| Lava says", JSON.stringify(s.receipt ?? null));

  if (DONE_STATUSES.includes(lavaStatus)) {
    const receipt = s.receipt ?? {};
    const paid = Number(receipt.amount);
    // The lesson from the Platega bridge: processors may report fee-inclusive
    // or slightly adjusted amounts. Refuse only when LESS than expected was
    // paid; an overpayment must never block delivery.
    if (!rec.amount || !rec.currency || !isFinite(paid) || paid + 1e-9 < Number(rec.amount) || String(receipt.currency ?? "").toUpperCase() !== rec.currency) {
      console.log("MISMATCH", invoiceId, "expected", rec.amount, rec.currency, "Lava", JSON.stringify(receipt));
      await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec), ttl);
      return { ok: false, reason: "mismatch" };
    }
    // SellAuth is the source of truth for "already delivered" (survives KV lag and retries).
    const inv = await getInvoice(env, invoiceId);
    const st = String(INVOICE.status(inv) ?? "").toLowerCase();
    if (INVOICE.doneStatuses.includes(st)) {
      console.log("invoice already completed in SellAuth:", invoiceId);
    } else {
      try {
        await processInvoice(env, invoiceId);
      } catch (e) {
        console.log("ALERT: payment COMPLETED but SellAuth process failed", invoiceId, String(e));
        throw e; // webhook returns 500 (Lava retries up to 20x) and cron retries for 6h
      }
      console.log("SellAuth invoice processed", invoiceId);
    }
    rec.delivered = true;
    await env.STATE.delete(`pending:${invoiceId}`);
  } else if (DEAD_STATUSES.includes(lavaStatus)) {
    await env.STATE.delete(`pending:${invoiceId}`);
  }
  await env.STATE.put(`inv:${invoiceId}`, JSON.stringify(rec), ttl);
  return { ok: true, reason: lavaStatus };
}

// POST /lava/callback  (webhook URL configured in the Lava product settings)
async function handleCallback(env, request) {
  if (!verifyCallback(env, request)) {
    // Header presence only, never values.
    console.log("callback REJECTED (401): X-Api-Key present =", !!request.headers.get("X-Api-Key"));
    return text("Unauthorized", 401);
  }
  let body;
  try { body = await request.json(); } catch { console.log("callback authorized but body is not JSON"); return text("OK", 200); }
  console.log("callback authorized. eventType:", body?.eventType ?? body?.event_type, "| contractId:", body?.contractId, "| status:", body?.status);
  const contractId = body?.contractId;
  if (!validUuid(contractId)) { console.log("callback has no valid `contractId`; acknowledged"); return text("OK", 200); }
  try {
    const r = await settle(env, contractId);
    console.log("callback result", contractId, JSON.stringify(r));
  } catch (e) {
    console.log("settle failed", contractId, String(e));
    return text("Error", 500); // Lava retries up to 20 times; cron also retries for 6h
  }
  return text("OK", 200); // unknown/failed/refund events are acknowledged, never retried by us
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      const missing = missingConfig(env);
      if (missing.length) return text(`Lava x SellAuth bridge: setup incomplete.\nMissing: ${missing.join(", ")}\nAdd them in Cloudflare > Worker > Settings > Variables and Secrets (type: Secret).`, 503);
      if (shopUrlIsPlaceholder(env)) return text("Lava x SellAuth bridge: running, but SELLAUTH_SHOP_URL is not set (edit wrangler.toml).");
      return text(`Lava x SellAuth bridge is running. build ${BUILD}`);
    }
    if (request.method === "GET" && pathname === "/lava/callback") {
      return text("Lava webhook endpoint. Lava sends POST requests here; nothing to see in a browser.");
    }
    if (request.method === "GET" && pathname === "/start") {
      const missing = missingConfig(env);
      if (missing.length) { console.log("Not configured. Missing:", missing.join(", ")); return text("Service is not configured yet.", 503); }
      try { return await handleStart(env, request); }
      catch (e) {
        console.log("start failed", String(e));
        // Surface Lava's amount limits to the buyer ("Amount=3.99 not in
        // allowed limits=(5, 10000) for USD") instead of a blank error page.
        const m = typeof e?.detail === "string" && e.detail.match(/limits=\(([^,)]+),\s*([^)]+)\)\s*for\s*([A-Z]{3})/);
        if (m) return text(`This payment method supports amounts from ${m[1]} to ${m[2]} ${m[3]}. Please choose a different amount or payment method.`, 502);
        return text("Could not start payment.", 502);
      }
    }
    if (request.method === "POST" && pathname === "/lava/callback") return handleCallback(env, request);
    return text("Not found", 404);
  },

  async scheduled(_event, env, ctx) {
    if (missingConfig(env).length) return;
    const list = await env.STATE.list({ prefix: "pending:", limit: 50 });
    for (const k of list.keys) {
      ctx.waitUntil((async () => {
        const invoiceId = k.name.slice("pending:".length);
        const rec = await env.STATE.get(`inv:${invoiceId}`, "json");
        if (rec?.contractId) await settle(env, rec.contractId);
      })().catch((e) => console.log("cron settle failed", k.name, String(e))));
    }
  },
};
