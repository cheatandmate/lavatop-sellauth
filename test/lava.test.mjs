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
assert.equal(rr.status, 200); assert.match(await rr.text(), /build /);
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
};
const contracts = {};          // contractId -> { status, amount, currency }
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
    const id = newContract();
    contracts[id] = { status: "NEW", amount: b.amount, currency: b.currency };
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
    return j({ Valute: { USD: { Nominal: 1, Value: 90.5 } } });
  }
  if (url.startsWith("https://open.er-api.com")) {
    if (!fxUp) throw new Error("fx down");
    return j({ result: "success", rates: { USD: 1.10, RUB: 100 } }); // base = target currency
  }
  throw new Error("unexpected " + url);
};
const cb = (headers, body) => worker.fetch(new Request("https://w.example/lava/callback", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
const start = (qs) => worker.fetch(new Request("https://w.example/start?" + qs), env);
const good = { "X-Api-Key": env.LAVA_WEBHOOK_KEY };
const nProc = (id) => proc.filter((x) => x === String(id)).length;
const nStarts = () => calls.filter((c) => c[1].endsWith("/api/v3/invoice")).length;
const wh = (contractId, eventType = "payment.success") => ({ eventType, contractId, amount: 500, currency: "RUB", status: "completed", timestamp: "2026-01-01T00:00:00Z" });

// 3. start: tampered URL amount ignored, RUB invoice charged as-is
let r = await start("invoice=7&ref=abc123&amount=0.01&currency=USD&email=x@y.z");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(1));
assert.equal(contracts[cid(1)].amount, 500);         // SellAuth price, not URL
assert.equal(await env.STATE.get("tx:" + cid(1)), "7");
// repeat while alive -> reuses the same payment, no second create
r = await start("invoice=7&ref=abc123"); assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(1));
assert.equal(nStarts(), 1);
console.log("ok  start (invoice amount used, URL tampering ignored, no duplicate contract)");

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
r = await start("invoice=7&ref=abc123"); assert.equal(r.status, 302);
assert.equal(r.headers.get("location"), "https://pay.lava.top/" + cid(2)); assert.equal(nStarts(), 2);
console.log("ok  failed contract is replaced by a fresh one on retry");

// 6. correct confirmation -> delivered exactly once, replay-safe
contracts[cid(2)].status = "COMPLETED";
r = await cb(good, wh(cid(2))); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
r = await cb(good, wh(cid(2))); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
// paid invoice -> back to SellAuth checkout
r = await start("invoice=7&ref=abc123");
assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/abc123");
console.log("ok  delivery only after Lava confirms COMPLETED; exactly once");

// 7. unknown contract / events / junk acknowledged without side effects
r = await cb(good, wh("00000000-0000-0000-0000-000000000000")); assert.equal(r.status, 200); assert.equal(nProc(7), 1);
r = await cb(good, { event_id: "x", event_type: "refund.success", contractId: cid(2) }); assert.equal(r.status, 200);
r = await cb(good, { event_type: "chargeback.initiated" }); assert.equal(r.status, 200);
r = await cb(good, "not json object"); assert.equal(r.status, 200);
console.log("ok  unknown contract / events / junk acknowledged without side effects");

// 8. USD invoice converted to RUB at the CBR rate, rounded up, cached; markup; fail-closed
r = await start("invoice=8&ref=u1&amount=0.01&currency=RUB");
assert.equal(r.status, 302);
const rec8 = await env.STATE.get("inv:8", "json");
assert.equal(rec8.amount, "904.10"); assert.equal(rec8.currency, "RUB"); assert.equal(rec8.orig, "9.99 USD");
assert.equal(rec8.contractId, cid(3));
const cbrCalls = () => calls.filter((c) => c[1].includes("cbr-xml-daily")).length;
assert.equal(cbrCalls(), 1);
kv.delete("inv:8"); kv.delete("tx:" + cid(3)); kv.delete("pending:8");
env.LAVA_MARKUP_PCT = "2";
r = await start("invoice=8&ref=u1"); assert.equal(r.status, 302);
assert.equal((await env.STATE.get("inv:8", "json")).amount, "922.18"); // 904.095*1.02 = 922.1769 -> up
assert.equal(cbrCalls(), 1, "rate served from cache");
delete env.LAVA_MARKUP_PCT;
kv.delete("rate:USD:RUB"); kv.delete("inv:8"); kv.delete("tx:" + cid(4)); kv.delete("pending:8"); fxUp = false;
r = await start("invoice=8&ref=u1"); assert.equal(r.status, 502); // no cache, source down -> refuse
kv.set("rate:USD:RUB", JSON.stringify({ rate: 90.5, ts: Date.now() - 3 * 3600 * 1000 }));
r = await start("invoice=8&ref=u1"); assert.equal(r.status, 302); // stale cache beats nothing
fxUp = true;
// unreadable invoice and non-payable invoices never reach Lava
const before = nStarts();
r = await start("invoice=9&ref=z"); assert.equal(r.status, 502);
r = await start("invoice=13&ref=old1");
assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/old1");
r = await start("invoice=14&ref=done1"); assert.equal(r.headers.get("location"), "https://shop.mysellauth.com/checkout/done1");
assert.equal(nStarts(), before);
console.log("ok  USD->RUB conversion (CBR, round up, markup, cache, stale fallback, fail closed)");

// 9. EUR target via open.er-api.com; amount mismatch (underpay) refused, overpay delivers
env.LAVA_CURRENCY = "EUR";
kv.delete("inv:8"); kv.delete("tx:" + cid(5)); kv.delete("pending:8"); // fresh contract in EUR
r = await start("invoice=8&ref=e1"); assert.equal(r.status, 302);
const rec8e = await env.STATE.get("inv:8", "json");
assert.equal(rec8e.currency, "EUR"); assert.equal(rec8e.amount, "9.09"); // 9.99/1.1 -> 9.0818 -> 9.09
assert.equal(rec8e.contractId, cid(6));
const erCalls = () => calls.filter((c) => c[1].includes("open.er-api.com")).length;
assert.equal(erCalls(), 1);
contracts[cid(6)].status = "COMPLETED"; contracts[cid(6)].amount = 8; contracts[cid(6)].currency = "EUR";
r = await cb(good, wh(cid(6))); assert.equal(nProc(8), 0);
contracts[cid(6)].amount = 9.20;
r = await cb(good, wh(cid(6))); assert.equal(nProc(8), 1);
delete env.LAVA_CURRENCY;
console.log("ok  EUR target (er-api) + underpay refused, overpay delivers");

// 10. cron delivers a missed webhook
kv.clear(); proc.length = 0; contractSeq = 0; calls.length = 0;
for (const k of Object.keys(contracts)) delete contracts[k];
invoices[15].status = "pending";
r = await start("invoice=15&ref=c1"); assert.equal(r.status, 302);
assert.equal((await env.STATE.get("inv:15", "json")).contractId, cid(1));
contracts[cid(1)].status = "COMPLETED";
const waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
assert.equal(nProc(15), 1);
console.log("ok  cron delivers when webhook was missed");

// 11. KV loss: replayed webhook can't deliver without the tx mapping
kv.delete("tx:" + cid(1));
r = await cb(good, wh(cid(1))); assert.equal(nProc(15), 1);
console.log("ok  webhook without KV mapping is a no-op (no KV -> no delivery)");
