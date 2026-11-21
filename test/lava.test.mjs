import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { LAVA_API_KEY: "lk", LAVA_WEBHOOK_KEY: "wk", LAVA_OFFER_ID: "836b9fc5-7ae9-4a27-9642-592bc44072b7",
  SELLAUTH_API_KEY: "sa", SELLAUTH_SHOP_ID: "42", SELLAUTH_SHOP_URL: "https://shop.mysellauth.com/" };

const kv = new Map();
env.STATE = { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };

// 1. configuration self-check
const bare = { STATE: env.STATE };
let rr = await worker.fetch(new Request("https://w.example/"), bare);
assert.equal(rr.status, 503);
const body0 = await rr.text();
assert.ok(body0.includes("LAVA_API_KEY") && body0.includes("SELLAUTH_API_KEY") && body0.includes("LAVA_WEBHOOK_KEY"));
assert.equal((await worker.fetch(new Request("https://w.example/start?invoice=7"), bare)).status, 503);
const ph = { ...env, LAVA_WEBHOOK_KEY: "your-lava-webhook-key" };
assert.equal((await worker.fetch(new Request("https://w.example/"), ph)).status, 503);
rr = await worker.fetch(new Request("https://w.example/"), env);
assert.equal(rr.status, 200); assert.match(await rr.text(), /build 2026-11-21\.2/);
console.log("ok  setup self-check (missing names listed, placeholders rejected)");

// 2. webhook auth: missing / wrong key -> 401, nothing processed
const calls = []; const proc = [];
const invoices = {
  7:  { id: 7,  price: "500.00", currency: "RUB", email: "b@x.io", status: "pending" },
  8:  { id: 8,  price: "9.99",   currency: "USD", email: "b@x.io", status: "pending" },
  9:  { id: 9,  price: "5" },                                  // no currency
  13: { id: 13, price: "1.00",  currency: "RUB", status: "cancelled" },
  14: { id: 14, price: "2.00",  currency: "RUB", status: "completed" },
  15: { id: 15, price: "10.00", currency: "RUB", email: "b@x.io", status: "pending" },
  16: { id: 16, price: "5.00",  currency: "EUR", email: "b@x.io", status: "pending" },
  17: { id: 17, price: "4.00",  currency: "USD", email: "b@x.io", status: "pending" },
  18: { id: 18, price: "3.00",  currency: "USD", email: "b@x.io", status: "pending" },
  19: { id: 19, price: "6.00",  currency: "USD", email: "b@x.io", status: "pending" },
  20: { id: 20, price: "3.99",  currency: "USD", email: "b@x.io", status: "pending" },
  21: { id: 21, price: "8.00",  currency: "USD", email: "b@x.io", status: "pending" },
  22: { id: 22, price: "1000",  currency: "RUB", email: "b@x.io", status: "pending" },
};
const contracts = {};          // contractId -> { status, amount, currency, provider, method }
let contractSeq = 0;
const cid = (n) => `3fa85f64-5717-4562-b3fc-${String(n).padStart(12, "0")}`;
const newContract = () => cid(++contractSeq);
let fxUp = true;
globalThis.fetch = async (url, opt = {}) => {
  calls.push([opt.method || "GET", url]);
  const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (url.includes("api.sellauth.com")) {
    const m = url.match(/\/invoices\/(\d+)(\/process)?/);
    if (m[2]) { invoices[m[1]].status = "completed"; proc.push(m[1]); return j({ ok: true }); }
    return j({ data: invoices[m[1]] });
  }
  if (url.includes("gate.lava.top") && url.endsWith("/api/v3/invoice")) {
    assert.equal(opt.method, "POST");
    assert.equal(opt.headers["X-Api-Key"], env.LAVA_API_KEY);
    const b = JSON.parse(opt.body);
    assert.equal(b.offerId, env.LAVA_OFFER_ID);
    if (b.currency === "USD" && b.amount < 5) {  // Lava's real minimum for USD
      return j({ error: `Amount=${b.amount} not in allowed limits=(5, 10000) for USD`, details: {} }, 400);
    }
    const id = newContract();
    contracts[id] = { status: "NEW", amount: b.amount, currency: b.currency, provider: b.paymentProvider, method: b.paymentMethod };
    return j({ id, status: "new", amountTotal: { currency: b.currency, amount: b.amount }, paymentUrl: `https://pay.lava.top/${id}` });
  }
  if (url.includes("gate.lava.top") && /\/api\/v1\/invoices\/[^/]+$/.test(url)) {
    const id = url.split("/").pop();
    const c = contracts[id];
    assert.ok(c, "contract state for " + id);
    return j({ id, status: c.status, receipt: { amount: c.amount, currency: c.currency, fee: 0 } });
  }
  if (url === "https://www.cbr-xml-daily.ru/daily_json.js") {
    if (!fxUp) throw new Error("cbr down");
    return j({ Valute: { USD: { Nominal: 1, Value: 90.5 }, EUR: { Nominal: 1, Value: 100 } } });
  }
  if (url.startsWith("https://open.er-api.com")) {
    if (!fxUp) throw new Error("fx down");
    return j({ result: "success", rates: { USD: 1.10, RUB: 100, EUR: 1 / 1.1 } }); // base = target currency
  }
  throw new Error("unexpected " + url);
};
const cb = (headers, body) => worker.fetch(new Request("https://w.example/lava/callback", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
const start = (qs) => worker.fetch(new Request("https://w.example/start?" + qs), env);
const good = { "X-Api-Key": env.LAVA_WEBHOOK_KEY };
const nProc = (id) => proc.filter((x) => x === String(id)).length;
const nStarts = () => calls.filter((c) => c[1].endsWith("/api/v3/invoice")).length;
const wh = (contractId, eventType = "payment.success") => ({ eventType, contractId, amount: 500, currency: "RUB", status: "completed", timestamp: "2026-01-01T00:00:00Z" });

// 3. RUB invoice with pay=sbp -> PAY2ME + SBP; tampered URL amount ignored
let r = await start("invoice=7&ref=abc123&amount=0.01&currency=USD&email=x@y.z&pay=sbp");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(1));
assert.equal(contracts[cid(1)].amount, 500);               // SellAuth price, not URL
assert.equal(contracts[cid(1)].currency, "RUB");
assert.equal(contracts[cid(1)].provider, "PAY2ME");
assert.equal(contracts[cid(1)].method, "SBP");
assert.equal(await env.STATE.get("tx:" + cid(1)), "7");
// repeat while alive -> reuses the same payment, no second create
r = await start("invoice=7&ref=abc123&pay=sbp"); assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(1));
assert.equal(nStarts(), 1);
console.log("ok  start (invoice amount used, URL tampering ignored, pay=sbp -> PAY2ME/SBP, no duplicate contract)");

// 4. webhook auth
for (const h of [{}, { "X-Api-Key": "wrong" }]) {
  r = await cb(h, wh(cid(1))); assert.equal(r.status, 401);
}
assert.equal(proc.length, 0);
// authorized, contract not yet paid -> no delivery
r = await cb(good, wh(cid(1))); assert.equal(r.status, 200); assert.equal(nProc(7), 0);
console.log("ok  webhook rejects bad/missing key (401); nothing delivered while NEW");

// 5. failed payment -> pending cleared, next /start opens a NEW contract
contracts[cid(1)].status = "FAILED";
r = await cb(good, wh(cid(1), "payment.failed")); assert.equal(r.status, 200); assert.equal(nProc(7), 0);
assert.equal(await env.STATE.get("pending:7"), null);
r = await start("invoice=7&ref=abc123");                    // no pay param -> env defaults (PAY2ME, no method)
assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(2)); assert.equal(nStarts(), 2);
assert.equal(contracts[cid(2)].provider, undefined);      // env has no provider -> Lava default
assert.equal(contracts[cid(2)].method, undefined);
console.log("ok  failed contract replaced; without pay= the env defaults apply");

// 6. correct confirmation -> delivered exactly once, replay-safe
contracts[cid(2)].status = "COMPLETED";
r = await cb(good, wh(cid(2))); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
r = await cb(good, wh(cid(2))); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
// paid invoice -> back to SellAuth checkout
r = await start("invoice=7&ref=abc123");
assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/abc123");
console.log("ok  delivery only after Lava confirms COMPLETED; exactly once");

// 7. unknown contract / events / junk acknowledged without side effects
r = await cb(good, wh(cid(999))); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
r = await cb(good, { event_id: "x", event_type: "refund.success", contractId: cid(2) }); assert.equal(r.status, 200);
r = await cb(good, { event_type: "chargeback.initiated" }); assert.equal(r.status, 200);
r = await cb(good, "not json object"); assert.equal(r.status, 200);
console.log("ok  unknown contract / events / junk acknowledged without side effects");

// 8a. USD invoice WITHOUT pay -> charged in USD via PayPal
r = await start("invoice=8&ref=u1&amount=0.01&currency=RUB");
assert.equal(r.status, 302);
assert.equal(contracts[cid(3)].currency, "USD");
assert.equal(contracts[cid(3)].amount, 9.99);
assert.equal(contracts[cid(3)].provider, "PAYPAL");
assert.equal(contracts[cid(3)].method, undefined);
// underpayment refused, exact payment delivers
contracts[cid(3)].status = "COMPLETED"; contracts[cid(3)].amount = 8;
r = await cb(good, wh(cid(3))); assert.equal(nProc(8), 0);
contracts[cid(3)].amount = 9.99;
r = await cb(good, wh(cid(3))); assert.equal(nProc(8), 1);
console.log("ok  USD without pay -> PayPal in USD; underpay refused");

// 8b. USD invoice WITH pay=sbp -> converted to RUB, charged via PAY2ME/SBP
r = await start("invoice=17&ref=u2&pay=sbp");
assert.equal(r.status, 302);
assert.equal(contracts[cid(4)].currency, "RUB");
assert.equal(contracts[cid(4)].amount, 362);               // 4 USD x 90.5 -> up (number in the API body)
assert.equal(contracts[cid(4)].provider, "PAY2ME");
assert.equal(contracts[cid(4)].method, "SBP");
const rec17 = await env.STATE.get("inv:17", "json");
assert.equal(rec17.amount, "362.00"); assert.equal(rec17.orig, "4.00 USD"); assert.equal(rec17.currency, "RUB");
console.log("ok  USD with pay=sbp -> converted to RUB via PAY2ME/SBP");

// 8c. USD invoice WITH pay=card -> converted to RUB, NO provider/method (Lava default = card)
r = await start("invoice=18&ref=u3&pay=card");
assert.equal(r.status, 302);
assert.equal(contracts[cid(contractSeq)].currency, "RUB");
assert.equal(contracts[cid(contractSeq)].amount, 271.5);   // 3 USD x 90.5
assert.equal(contracts[cid(contractSeq)].provider, undefined);
assert.equal(contracts[cid(contractSeq)].method, undefined);
console.log("ok  USD with pay=card -> RUB with no provider/method (Lava default checkout)");

// 9. EUR invoice -> converted to RUB at the CBR rate (pay=sbp honored)
r = await start("invoice=16&ref=e1&pay=sbp");
assert.equal(r.status, 302);
const rec16 = await env.STATE.get("inv:16", "json");
assert.equal(rec16.amount, "500.00"); assert.equal(rec16.currency, "RUB"); assert.equal(rec16.orig, "5.00 EUR");
assert.equal(contracts[rec16.contractId].provider, "PAY2ME");
assert.equal(contracts[rec16.contractId].method, "SBP");
const cbrCalls = () => calls.filter((c) => c[1].includes("cbr-xml-daily")).length;
assert.equal(cbrCalls(), 2);                              // USD->RUB (8b) + EUR->RUB
// underpay / overpay on the converted amount
contracts[rec16.contractId].status = "COMPLETED"; contracts[rec16.contractId].amount = 400;
r = await cb(good, wh(rec16.contractId)); assert.equal(nProc(16), 0);
contracts[rec16.contractId].amount = 600;
r = await cb(good, wh(rec16.contractId)); assert.equal(nProc(16), 1);
console.log("ok  EUR -> RUB conversion (CBR) + underpay refused, overpay delivers");

// 10. markup + rate cache + stale fallback on the conversion path
kv.delete("inv:16"); kv.delete("tx:" + rec16.contractId); kv.delete("pending:16"); invoices[16].status = "pending";
env.LAVA_MARKUP_PCT = "2";
const cbrBefore = cbrCalls();
r = await start("invoice=16&ref=e1&pay=sbp"); assert.equal(r.status, 302);
assert.equal((await env.STATE.get("inv:16", "json")).amount, "510.00"); // 500*1.02
assert.equal(cbrCalls(), cbrBefore, "rate served from cache");
delete env.LAVA_MARKUP_PCT;
// unknown pay param -> env defaults
invoices[16].status = "pending";
let last = (await env.STATE.get("inv:16", "json")).contractId;
kv.delete("inv:16"); kv.delete("tx:" + last); kv.delete("pending:16"); invoices[16].status = "pending";
r = await start("invoice=16&ref=e1&pay=bank"); assert.equal(r.status, 302);
assert.equal(contracts[cid(contractSeq)].provider, undefined);
assert.equal(contracts[cid(contractSeq)].method, undefined);
// rate source down: no cache -> refuse; stale cache -> still works
kv.delete("rate:EUR:RUB");
last = (await env.STATE.get("inv:16", "json")).contractId;
kv.delete("inv:16"); kv.delete("tx:" + last); kv.delete("pending:16"); invoices[16].status = "pending"; fxUp = false;
r = await start("invoice=16&ref=e1"); assert.equal(r.status, 502);
kv.set("rate:EUR:RUB", JSON.stringify({ rate: 100, ts: Date.now() - 3 * 3600 * 1000 }));
r = await start("invoice=16&ref=e1"); assert.equal(r.status, 302);
fxUp = true;
// non-payable invoices never reach Lava
const before = nStarts();
r = await start("invoice=9&ref=z"); assert.equal(r.status, 502);
r = await start("invoice=13&ref=old1");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/old1");
r = await start("invoice=14&ref=done1"); assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/done1");
assert.equal(nStarts(), before);
console.log("ok  markup, cache, stale fallback, unknown pay param, fail closed");

// 11. pay=paypal: EUR invoice converts to USD via er-api -> PayPal
invoices[16].status = "pending";
last = (await env.STATE.get("inv:16", "json")).contractId;
kv.delete("inv:16"); kv.delete("tx:" + last); kv.delete("pending:16");
const erCalls = () => calls.filter((c) => c[1].includes("open.er-api.com")).length;
r = await start("invoice=16&ref=e2&pay=paypal");
assert.equal(r.status, 302);
const rec16u = await env.STATE.get("inv:16", "json");
assert.equal(rec16u.currency, "USD"); assert.equal(rec16u.amount, "5.50"); // 5 EUR x 1.1 USD/EUR -> up
assert.equal(contracts[rec16u.contractId].provider, "PAYPAL");
assert.equal(erCalls(), 1);
// USD invoice with explicit pay=paypal -> native USD, no conversion
r = await start("invoice=19&ref=p1&pay=paypal");
assert.equal(r.status, 302);
assert.equal(contracts[cid(contractSeq)].currency, "USD");
assert.equal(contracts[cid(contractSeq)].amount, 6);
assert.equal(contracts[cid(contractSeq)].provider, "PAYPAL");
assert.equal(erCalls(), 1);
console.log("ok  pay=paypal: EUR -> USD (er-api) and native USD, both via PayPal");

// 11b. USD below Lava's minimum ($5) -> buyer-friendly message, not a blank page
r = await start("invoice=20&ref=min&pay=paypal");
assert.equal(r.status, 502);
assert.match(await r.text(), /from 5 to 10000 USD/);
console.log("ok  USD below the $5 minimum -> buyer-friendly limits message");

// 11c. pay=pix: native USD via UNLIMINT+PIX, and RUB converted to USD
r = await start("invoice=21&ref=x1&pay=pix");
assert.equal(r.status, 302);
assert.equal(contracts[cid(contractSeq)].currency, "USD");
assert.equal(contracts[cid(contractSeq)].amount, 8);
assert.equal(contracts[cid(contractSeq)].provider, "UNLIMINT");
assert.equal(contracts[cid(contractSeq)].method, "PIX");
const erBeforePix = erCalls();
r = await start("invoice=22&ref=x2&pay=pix");
assert.equal(r.status, 302);
assert.equal(contracts[cid(contractSeq)].currency, "USD");
assert.equal(contracts[cid(contractSeq)].amount, 10);      // 1000 RUB x 0.01
assert.equal(contracts[cid(contractSeq)].provider, "UNLIMINT");
assert.equal(contracts[cid(contractSeq)].method, "PIX");
assert.equal(erCalls(), erBeforePix + 1, "RUB->USD rate via er-api");
console.log("ok  pay=pix: native USD and RUB->USD, both via UNLIMINT+PIX");

// 11d. applepay (USD), ideal/sepa/bancontact (EUR) -- each resets its invoice KV first
const methodCases = [
  ["invoice=21&ref=m1&pay=applepay",   21, "USD", 8,    "UNLIMINT", "APPLE_PAY"],
  ["invoice=22&ref=m2&pay=ideal",      22, "EUR", 10,   "UNLIMINT", "IDEAL"],       // 1000 RUB x 0.01
  ["invoice=16&ref=m3&pay=sepa",       16, "EUR", 5,    "UNLIMINT", "SEPATRANSFER"],
  ["invoice=18&ref=m4&pay=bancontact", 18, "EUR", 2.73, "UNLIMINT", "BANCONTACT"],  // 3 USD x 0.9091 -> up
  ["invoice=19&ref=m5&pay=cardusd",    19, "USD", 6,    undefined,  undefined],     // native USD
  ["invoice=16&ref=m6&pay=cardeur",    16, "EUR", 5,    undefined,  undefined],     // native EUR
  ["invoice=22&ref=m7&pay=cardusd",    22, "USD", 10,   undefined,  undefined],     // 1000 RUB -> USD
];
for (const [qs, inv, cur, amt, prov, meth] of methodCases) {
  invoices[inv].status = "pending";
  const prev = (await env.STATE.get(`inv:${inv}`, "json"))?.contractId;
  if (prev) { kv.delete(`inv:${inv}`); kv.delete("tx:" + prev); kv.delete(`pending:${inv}`); }
  r = await start(qs);
  assert.equal(r.status, 302, qs);
  const c = contracts[cid(contractSeq)];
  assert.equal(c.currency, cur, qs);
  assert.equal(c.amount, amt, qs);
  assert.equal(c.provider, prov, qs);
  assert.equal(c.method, meth, qs);
}
console.log("ok  pay=applepay/ideal/sepa/bancontact routed to the right currency+method");

// 12. cron delivers a missed webhook
kv.clear(); proc.length = 0; contractSeq = 0; calls.length = 0;
for (const k of Object.keys(contracts)) delete contracts[k];
invoices[15].status = "pending";
r = await start("invoice=15&ref=c1&pay=sbp"); assert.equal(r.status, 302);
assert.equal((await env.STATE.get("inv:15", "json")).contractId, cid(1));
assert.equal(contracts[cid(1)].method, "SBP");
contracts[cid(1)].status = "COMPLETED";
const waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
assert.equal(nProc(15), 1);
console.log("ok  cron delivers when webhook was missed");

// 13. KV loss: replayed webhook can't deliver without the tx mapping
kv.delete("tx:" + cid(1));
r = await cb(good, wh(cid(1))); assert.equal(nProc(15), 1);
console.log("ok  webhook without KV mapping is a no-op (no KV -> no delivery)");
