// server.js
// Node.js backend for SellAuth bridge + static HTML website
//
// Requires: Node 18+
// Install:  npm i express dotenv
// Run:      node server.js

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

// Resolve __dirname first (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Where to store locks
const DATA_DIR     = path.join(__dirname, "data");
const CHOICES_FILE = path.join(DATA_DIR, "choices.json");


// In-memory map: invoiceId -> "giftcard" | "account" | "item"
let CHOSEN_METHODS = new Map();

async function loadChoices() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(CHOICES_FILE, "utf8");
    const obj = JSON.parse(raw);
    CHOSEN_METHODS = new Map(Object.entries(obj));
    console.log(`[Choices] Loaded ${CHOSEN_METHODS.size} lock(s).`);
  } catch {
    CHOSEN_METHODS = new Map();
  }
}
async function saveChoices() {
  const obj = Object.fromEntries(CHOSEN_METHODS);
  await fs.writeFile(CHOICES_FILE, JSON.stringify(obj, null, 2), "utf8");
}
function getChoice(invoiceId) {
  return CHOSEN_METHODS.get(String(invoiceId));
}
async function setChoice(invoiceId, method) {
  const key = String(invoiceId);
  if (!["giftcard", "account", "item"].includes(method)) return;
  // don't overwrite an existing lock
  if (!CHOSEN_METHODS.has(key)) {
    CHOSEN_METHODS.set(key, method);
    await saveChoices();
    console.log(`[Choices] Locked ${key} -> ${method}`);
  }
}



// ---------------------------- Top-level error logs ----------------------------
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("[unhandledRejection]", err); process.exit(1); });

// ---------------------------- Config ----------------------------
function required(name, fallback = null) {
  const v = process.env[name] ?? fallback;
  if (v === null || v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}
const parseList = (s) => (s || "").split(",").map(x => x.trim()).filter(Boolean);

export const CONFIG = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseInt(process.env.PORT ?? "3000", 10),
  PUBLIC_URL: process.env.PUBLIC_URL ?? "http://localhost:3000",

  SA_API_BASE: process.env.SA_API_BASE ?? "https://api.sellauth.com/v1",
  SA_API_KEY: required("SA_API_KEY"),
  SA_SHOP_ID: required("SA_SHOP_ID"),

  WEBHOOK_SECRET: required("WEBHOOK_SECRET"),
  SIG_HEADER: process.env.SIG_HEADER ?? "X-Webhook-Signature",

  PAYOUT_CURRENCIES: parseList(process.env.PAYOUT_CURRENCIES || "ltc"),
  IDEMP_CACHE_TTL_MS: parseInt(process.env.IDEMP_CACHE_TTL_MS ?? "86400000", 10),
};

export const CURRENCY_CFG = Object.fromEntries(
  CONFIG.PAYOUT_CURRENCIES.map((cur) => {
    const addr = process.env[`PAYOUT_ADDRESS_${cur}`];
    const minUsd = parseFloat(process.env[`PAYOUT_MIN_USD_${cur}`] ?? "0");
    if (!addr) console.warn(`[WARN] Missing payout address for ${cur} (PAYOUT_ADDRESS_${cur})`);
    if (!Number.isFinite(minUsd)) throw new Error(`Invalid USD threshold for ${cur}: PAYOUT_MIN_USD_${cur}`);
    return [cur, { address: addr, minUsd }];
  })
);

export const COINGECKO_IDS = { btc: "bitcoin", ltc: "litecoin" };

// ---------------------------- Express setup (create app FIRST) ----------------------------
const app = express();


app.use(express.json());                               // JSON for normal APIs
app.use(express.static(path.join(__dirname, "public"))); // serves /public/* (index.html, assets)

// ---------------------------- SellAuth API helpers ----------------------------
const base = CONFIG.SA_API_BASE.replace(/\/+$/, "");
const shop = String(CONFIG.SA_SHOP_ID).trim();

const CANDIDATE_PATHS = {
  invoice: (id) => [
    `/shops/${encodeURIComponent(shop)}/invoices/${encodeURIComponent(id)}`,
    `/invoices/${encodeURIComponent(id)}?shop_id=${encodeURIComponent(shop)}`,
    `/invoices/${encodeURIComponent(id)}`,
  ],
  products: () => [
    `/shops/${encodeURIComponent(shop)}/products`,
    `/products?shop_id=${encodeURIComponent(shop)}`,
    `/products`,
  ],
  balances: () => [
    `/shops/${encodeURIComponent(shop)}/payouts/balances`,
    `/payouts/balances?shop_id=${encodeURIComponent(shop)}`,
    `/payouts/balances`,
  ],
  payout: () => [
    `/shops/${encodeURIComponent(shop)}/payouts/payout`,
    `/payouts/payout?shop_id=${encodeURIComponent(shop)}`,
    `/payouts/payout`,
  ],
};

function makeHeaderVariants() {
  return [
    { Authorization: `Bearer ${CONFIG.SA_API_KEY}`, "Content-Type": "application/json" },
    { "X-Api-Key": CONFIG.SA_API_KEY, "Content-Type": "application/json" },
    { "X-API-KEY": CONFIG.SA_API_KEY, "Content-Type": "application/json" },
  ];
}

async function trySellAuth(method, paths, body) {
  const headerVariants = makeHeaderVariants();
  let lastErr = null;

  for (const p of paths) {
    const url = `${base}${p}`;
    for (const headers of headerVariants) {
      try {
        const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        console.log(`[SellAuth ${method}] ${p} -> ${res.status} ${text.slice(0, 160)}`);
        if (res.ok) {
          try { return JSON.parse(text); } catch { return {}; }
        } else {
          lastErr = new Error(`HTTP ${res.status}: ${text}`);
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("All SellAuth request variants failed");
}

// Convenience wrappers
export async function getInvoice(invoiceId) {
  const paths = CANDIDATE_PATHS.invoice(invoiceId);
  return trySellAuth("GET", paths, null);
}
export async function getBalances() {
  const paths = CANDIDATE_PATHS.balances();
  return trySellAuth("GET", paths, null);
}
export async function createPayout({ currency, address, amount }) {
  if (!address) throw new Error(`No payout address configured for ${currency}`);
  const body = { currency, address, amount };
  const paths = CANDIDATE_PATHS.payout();
  return trySellAuth("POST", paths, body);
}

// ---------------------------- Prices (CoinGecko) ----------------------------
export async function getUsdPrices(coins) {
  const ids = coins.map((s) => COINGECKO_IDS[s] || s).filter(Boolean).join(",");
  if (!ids) return {};
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`Price API failed: ${res.status}`);
  return res.json();
}

// ---------------------------- Webhook signature verify ----------------------------
function verifyWebhookSignatureMiddleware() {
  return (req, res, next) => {
    try {
      const sig = req.get(CONFIG.SIG_HEADER);
      if (!sig) return res.status(400).send("Missing signature header");
      const computed = crypto.createHmac("sha256", CONFIG.WEBHOOK_SECRET).update(req.body).digest("hex");
      const ok = crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(String(sig), "hex"));
      if (!ok) return res.status(400).send("Invalid signature");
      next();
    } catch {
      return res.status(400).send("Signature verification failed");
    }
  };
}

// ---------------------------- Idempotency (in-memory) ----------------------------
const processedEvents = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of processedEvents) if (exp <= now) processedEvents.delete(k);
}, 60_000);
const seen = (id) => processedEvents.has(id);
const remember = (id) => processedEvents.set(id, Date.now() + CONFIG.IDEMP_CACHE_TTL_MS);

// ---------------------------- Auto-withdraw ----------------------------
export async function autoWithdrawIfEligible(preferredCurrency = null) {
  const balances = await getBalances();
  const coins = preferredCurrency ? [preferredCurrency] : Object.keys(CURRENCY_CFG);
  if (coins.length === 0) return;

  const prices = await getUsdPrices(coins);
  for (const cur of coins) {
    const cfg = CURRENCY_CFG[cur];
    if (!cfg || !cfg.address) { console.log(`[AutoWithdraw] ${cur}: not configured; skip.`); continue; }

    const available = Number(balances?.[cur]?.available ?? 0);
    if (!Number.isFinite(available) || available <= 0) { console.log(`[AutoWithdraw] ${cur}: no balance.`); continue; }

    const cgId = COINGECKO_IDS[cur] || cur;
    const priceUsd = Number(prices?.[cgId]?.usd ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) { console.log(`[AutoWithdraw] ${cur}: price unavailable.`); continue; }

    const usdValue = available * priceUsd;
    const minUsd = Number(cfg.minUsd ?? 0);
    console.log(`[AutoWithdraw] ${cur.toUpperCase()}: ${available} ≈ $${usdValue.toFixed(2)} (min $${minUsd})`);

    if (usdValue >= minUsd) {
      console.log(`[AutoWithdraw] ${cur.toUpperCase()}: withdrawing ${available}`);
      await createPayout({ currency: cur, address: cfg.address, amount: available });
    }
  }
}

// ---------------------------- Demo local stock ----------------------------
const localStock = [
  { sku: "ROB-100", name: "Robux 100", price: 4.99, stock: 25 },
  { sku: "ROB-500", name: "Robux 500", price: 21.99, stock: 10 },
  { sku: "NITRO1", name: "Discord Nitro 1 Month", price: 9.99, stock: 7 },
];
const redeemed = new Set();
function decStockBySku(sku, qty = 1) {
  const item = localStock.find((i) => i.sku === sku);
  if (item && item.stock > 0) item.stock = Math.max(0, item.stock - qty);
}

// ---------------------------- Products API (with pseudo live stock) ----------------------------
function seededRandom(seedStr) {
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seed = xmur3(seedStr)();
  return mulberry32(seed)();
}
function pseudoStock(productId, min = 5, max = 40, window = "day") {
  const now = new Date();
  const bucket =
    window === "hour"
      ? `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`
      : `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  const r = seededRandom(`${productId}-${bucket}`);
  return Math.floor(min + r * (max - min + 1));
}

// ---------------------------- Products API (robust, paginated) ----------------------------
// -------------------------------------------------------------
// /api/products — Manual (Currencies w/ two stocks + Live items)
// Grouped response + helper fields for product box
// -------------------------------------------------------------
let productsCache = { data: null, expiresAt: 0 };
const PRODUCTS_CACHE_MS = 60 * 1000; // 60s cache for responses

// ---------- Editable catalog (no stock numbers here) ----------
const CURRENCY_PRODUCTS = [
  { id: "robux-5000", name: "5,000 Robux", group: "Roblox Robux", price: 10.49, currency: "USD" },
  { id: "robux-10000", name: "10,000 Robux", group: "Roblox Robux", price: 15.99, currency: "USD" },
  { id: "robux-25000", name: "25,000 Robux", group: "Roblox Robux", price: 29.99, currency: "USD" },
  { id: "robux-50000", name: "50,000 Robux", group: "Roblox Robux", price: 54.99, currency: "USD" },
  { id: "robux-100000", name: "100,000 Robux", group: "Roblox Robux", price: 99.99, currency: "USD" },
  { id: "robux-2500000", name: "250,000 Robux", group: "Roblox Robux", price: 240.99, currency: "USD" },

  { id: "fortinite-13500", name: "13,500 V-Bucks", group: "Fortnite V-Bucks", price: 10.49, currency: "USD" },
  { id: "fortinite-26000", name: "26,000 V-Bucks", group: "Fortnite V-Bucks", price: 15.99, currency: "USD" },
  { id: "fortinite-40500", name: "40,500 V-Bucks", group: "Fortnite V-Bucks", price: 29.99, currency: "USD" },
  { id: "fortinite-100000", name: "100,000 V-Bucks", group: "Fortnite V-Bucks", price: 54.99, currency: "USD" },
  { id: "fortinite-200000", name: "200,000 V-Bucks", group: "Fortnite V-Bucks", price: 99.99, currency: "USD" },

  { id: "vp-5000", name: "5,000 Valorant Points", group: "Valorant Points", price: 10.49, currency: "USD" },
  { id: "vp-9500", name: "9,000 Valorant Points", group: "Valorant Points", price: 15.99, currency: "USD" },
  { id: "vp-20000", name: "20,000 Valorant Points", group: "Valorant Points", price: 29.99, currency: "USD" },
  { id: "vp-42000", name: "42,000 Valorant Points", group: "Valorant Points", price: 54.99, currency: "USD" },
  { id: "vp-95000", name: "95,000 Valorant Points", group: "Valorant Points", price: 99.99, currency: "USD" },
];

const LIVE_STOCK_PRODUCTS = [
  { id: "roblox-headless", name: "Headless Horseman Account", group: "Roblox Account", price: 44.99, currency: "USD" },
  { id: "roblox-korblox", name: "Korblox Account", group: "Roblox Account", price: 44.99, currency: "USD" },
  { id: "roblox-headless", name: "Headless Horseman And Korblox Account", group: "Roblox Account", price: 79.99, currency: "USD" },

  { id: "nitro-1m", name: "Discord Nitro Boost 1 Month", group: "Discord Nitro Boost", price: 6.99, currency: "USD" },
  { id: "nitro-1y", name: "Discord Nitro Boost 1 Year", group: "Discord Nitro Boost", price: 29.99, currency: "USD" },

  { id: "method-vp", name: "Valorant Points Method", group: "Method", price: 14.99, currency: "USD" },
  { id: "method-robux", name: "Robux Method", group: "Method", price: 14.99, currency: "USD" },
  { id: "method-vbucks", name: "V-Bucks Points Method", group: "Method", price: 14.99, currency: "USD" },
  { id: "method-nitro", name: "Nitro Method", group: "Method", price: 14.99, currency: "USD" },

  { id: "minecraft", name: "Minecraft FA Account", group: "Minecraft", price: 6.99, currency: "USD" },
];

// ---------- Global stock generation & update policy ----------
const UPDATE_MIN_MS = 30 * 60 * 1000;  // 30 min
const UPDATE_MAX_MS = 45 * 60 * 1000;  // 45 min

// Initial random ranges (used when a product first appears or after a reset)
const DEFAULT_RANGES = {
  account:  [12, 48],   // account-based top-ups/creds
  giftcard: [6, 24],    // prepaid code pool
  live:     [18, 90],   // live/one-off items
};

// Per-update delta magnitude (gentle changes so it feels natural)
const DELTA_RANGE = {
  account: [-3, 3],
  giftcard: [-3, 3],
  live: [-4, 4],
};

// Hard floor/ceiling to keep values reasonable over time
const HARD_LIMITS = {
  account: [0, 9999],
  giftcard: [0, 9999],
  live: [0, 9999],
};

// ---------- Utilities ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randDelay = (minMs, maxMs) => randInt(minMs, maxMs);

// ---------- In-memory stock state & timers ----------
/**
 * STOCK_STATE: Map<string, {
 *    type: "currency" | "live",
 *    stock: { account?:number, giftcard?:number, live?:number },
 *    timers: { account?:Timeout, giftcard?:Timeout, live?:Timeout }
 * }>
 */
const STOCK_STATE = new Map();

/** Resolve bucket range for a product (policy override → default) */
function resolveRange(product, bucket) {
  const policy = product.policy;
  const override = policy && Array.isArray(policy[bucket]) ? policy[bucket] : null;
  const [min, max] = override || DEFAULT_RANGES[bucket];
  return [Number(min), Number(max)];
}

/** Ensure product has initial stock and scheduled updates (lazy init) */
function ensureStock(product, type) {
  let s = STOCK_STATE.get(product.id);
  if (!s) {
    s = { type, stock: {}, timers: {} };
    STOCK_STATE.set(product.id, s);

    if (type === "currency") {
      const [aMin, aMax] = resolveRange(product, "account");
      const [gMin, gMax] = resolveRange(product, "giftcard");
      s.stock.account = randInt(aMin, aMax);
      s.stock.giftcard = randInt(gMin, gMax);
      scheduleNext("account", product.id);
      scheduleNext("giftcard", product.id);
    } else {
      const [lMin, lMax] = resolveRange(product, "live");
      s.stock.live = randInt(lMin, lMax);
      scheduleNext("live", product.id);
    }
  }
  return s;
}

/** Schedule the next update for a bucket with random 1h–1.5h delay */
function scheduleNext(bucket, productId) {
  const state = STOCK_STATE.get(productId);
  if (!state) return;
  // Clear existing timer if any
  if (state.timers[bucket]) clearTimeout(state.timers[bucket]);

  const delay = randDelay(UPDATE_MIN_MS, UPDATE_MAX_MS);
  state.timers[bucket] = setTimeout(() => {
    applyDelta(bucket, productId);
    scheduleNext(bucket, productId); // reschedule again
  }, delay);
}

/** Apply a small +/- delta to one bucket and clamp to limits */
function applyDelta(bucket, productId) {
  const state = STOCK_STATE.get(productId);
  if (!state) return;

  const [dMin, dMax] = DELTA_RANGE[bucket];
  const [hMin, hMax] = HARD_LIMITS[bucket];

  const cur = Number(state.stock[bucket] || 0);
  const delta = randInt(dMin, dMax);
  const next = clamp(cur + delta, hMin, hMax);

  state.stock[bucket] = next;
  // Bust response cache so the next GET reflects the change
  productsCache = { data: null, expiresAt: 0 };
}

// ---------- Normalizers (build response items the UI expects) ----------
function normalizeCurrencyProduct(p) {
  const s = ensureStock(p, "currency").stock;
  const account = Math.max(0, Number(s.account || 0));
  const giftcard = Math.max(0, Number(s.giftcard || 0));
  const total = account + giftcard;

  return {
    id: String(p.id),
    name: String(p.name || "Product"),
    group: p.group || "Ungrouped",
    price: Number(p.price || 0),
    currency: (p.currency || "").toUpperCase() || null,

    // For your UI:
    stockType: "currency",
    stock: { account, giftcard, total },
    liveStock: total, // compatibility with single-number readers
  };
}

function normalizeLiveProduct(p) {
  const s = ensureStock(p, "live").stock;
  const live = Math.max(0, Number(s.live || 0));

  return {
    id: String(p.id),
    name: String(p.name || "Product"),
    group: p.group || "Ungrouped",
    price: p.price != null ? Number(p.price) : 0,
    currency: p.currency ? String(p.currency).toUpperCase() : null,

    stockType: "live",
    stock: { live, total: live },
    liveStock: live,
  };
}

function buildGroupedSnapshot({ debug = false } = {}) {
  const items = [
    ...CURRENCY_PRODUCTS.map(normalizeCurrencyProduct),
    ...LIVE_STOCK_PRODUCTS.map(normalizeLiveProduct),
  ];
  const groups = {};
  for (const it of items) {
    const g = it.group || "Ungrouped";
    (groups[g] ||= []).push(it);
  }
  const payload = { ok: true, groups, count: items.length, ts: Date.now() };
  if (debug) console.log("[/api/products][auto-stock] snapshot:", JSON.stringify(payload, null, 2));
  return payload;
}



// ---------- Route (grouped shape for compatibility) ----------
app.get("/api/products", async (req, res) => {
  try {
    const debug = req.query.debug === "1" || req.query.debug === "true";
    const nocache = req.query.nocache === "1" || req.query.nocache === "true";

    if (!nocache && productsCache.data && Date.now() < productsCache.expiresAt) {
      if (debug) console.log("[/api/products] serve from cache");
      return res.json(productsCache.data);
    }

    const payload = buildGroupedSnapshot({ debug });
    productsCache = { data: payload, expiresAt: Date.now() + PRODUCTS_CACHE_MS };
    res.json(payload);
  } catch (err) {
    console.error("[/api/products] error:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------- Optional admin helpers ----------
/** Force-randomize all stocks now (keeps timers) */
app.post("/api/products/reset-stocks", (_req, res) => {
  // Clear cache first
  productsCache = { data: null, expiresAt: 0 };

  for (const p of CURRENCY_PRODUCTS) {
    const s = ensureStock(p, "currency");
    const [aMin, aMax] = resolveRange(p, "account");
    const [gMin, gMax] = resolveRange(p, "giftcard");
    s.stock.account = randInt(aMin, aMax);
    s.stock.giftcard = randInt(gMin, gMax);
    scheduleNext("account", p.id);
    scheduleNext("giftcard", p.id);
  }
  for (const p of LIVE_STOCK_PRODUCTS) {
    const s = ensureStock(p, "live");
    const [lMin, lMax] = resolveRange(p, "live");
    s.stock.live = randInt(lMin, lMax);
    scheduleNext("live", p.id);
  }

  res.json({ ok: true, message: "Stocks randomized. Timers rescheduled." });
});

// Optional: force a jitter tick & clear cache so UI updates immediately
app.post("/api/products/jitter", (req, res) => {
  for (const p of CURRENCY_PRODUCTS) jitterCurrencyItem(p);
  for (const p of LIVE_STOCK_PRODUCTS) jitterLiveItem(p);
  productsCache = { data: null, expiresAt: 0 };
  res.json({ ok: true, message: "Jitter applied, cache cleared" });
});

app.get("/buy/:productId", (req, res) => {
  const { productId } = req.params;
  // This keeps the browser bar clean, no ?product= shown
  const target = `https://vortic.mysellauth.com/#${encodeURIComponent(productId)}`;
  res.redirect(302, target);
});

// ---------------------------- Core APIs used by your HTML ----------------------------
app.get("/health", (_req, res) => res.json({ ok: true, t: Date.now() }));
app.get("/ping", (_req, res) => res.json({ ok: true, t: Date.now() }));

app.get("/api/stock", (_req, res) => res.json({ ok: true, items: localStock }));

app.get("/api/invoice/:id", async (req, res) => {
  try {
    const data = await getInvoice(req.params.id);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(404).json({ ok: false, error: "Invoice not found" });
  }
});

app.post("/api/redeem", express.json(), async (req, res) => {
  try {
    const { invoiceId } = req.body || {};
    if (!invoiceId) return res.status(400).json({ ok: false, error: "invoiceId required" });
    if (redeemed.has(invoiceId)) return res.json({ ok: false, error: "Already redeemed" });

    const inv = await getInvoice(invoiceId);
    const status = String(inv?.status || inv?.data?.status || "").toLowerCase();
    if (!status || (!status.includes("paid") && !status.includes("complete"))) {
      return res.json({ ok: false, error: "Invoice not paid/complete" });
    }

    redeemed.add(invoiceId);
    res.json({ ok: true, message: "Redeemed successfully" });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ----- helpers you likely already have -----
// Helpers you likely already have:
// ---- Helpers (place near other helpers) ----
const SA_BASE = (CONFIG.SA_API_BASE || "https://api.sellauth.com/v1").replace(/\/$/, "");

function makeAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (CONFIG.SA_API_KEY) headers.Authorization = `Bearer ${CONFIG.SA_API_KEY}`;
  else headers["X-Api-Key"] = CONFIG.SA_API_KEY;
  return headers;
}

function isPaidLike(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("paid") || s.includes("complete") || s.includes("completed") || s === "success";
}

async function getJson(url, headers = {}, debug = false) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (debug) console.log(`[GET] ${url} -> ${r.status} ${text.slice(0, 200)}...`);
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  }
}


// Try several invoice URL variants & ?include= to coax back items/products
async function fetchInvoice(invoiceId, debug = false) {
  const inc = [
    "items,products,deliverables",
    "items,products",
    "items,deliverables",
    "products",
    "items",
  ];
  const urls = [
    ...inc.map(i => `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}?include=${i}`),
    `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}`,
    ...inc.map(i => `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}?shop_id=${CONFIG.SA_SHOP_ID}&include=${i}`),
    `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}?shop_id=${CONFIG.SA_SHOP_ID}`,
    `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}`
  ];

  for (const url of urls) {
    const r = await fetch(url, { headers: makeAuthHeaders() });
    const text = await r.text();
    if (debug) console.log(`[GET invoice] ${url} -> ${r.status} ${text.slice(0, 180)}...`);
    let json = null; try { json = JSON.parse(text); } catch { }
    if (r.ok && json) return json;
  }
  throw new Error("Invoice fetch failed");
}

// Try several endpoints that sometimes expose line items / deliverables
async function fetchInvoiceItems(invoiceId, debug = false) {
  const headers = makeAuthHeaders();
  const urls = [
    `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}/items`,
    `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}/items`,
    `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}/deliverables`,
    `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}/deliverables`,
  ];
  for (const url of urls) {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (debug) console.log(`[GET items] ${url} -> ${r.status} ${text.slice(0, 180)}...`);
    let j = null; try { j = JSON.parse(text); } catch { }
    if (!r.ok || !j) continue;

    const arr =
      Array.isArray(j?.data) ? j.data :
        Array.isArray(j?.items) ? j.items :
          Array.isArray(j?.deliverables) ? j.deliverables :
            Array.isArray(j) ? j : [];

    if (arr.length) return arr;
  }
  return [];
}

// If items only have product IDs, resolve those to names
async function fetchProductsByIds(ids = [], debug = false) {
  if (!ids.length) return {};
  const unique = [...new Set(ids.map(String))];

  // Some shops support /products?ids=1,2,3 ; otherwise GET one by one.
  const tryBatch = `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/products?ids=${unique.map(encodeURIComponent).join(",")}`;
  const headers = makeAuthHeaders();

  const map = {};

  // Try batch
  try {
    const r = await fetch(tryBatch, { headers });
    const text = await r.text();
    if (debug) console.log(`[GET products batch] -> ${r.status} ${text.slice(0, 160)}...`);
    if (r.ok) {
      let j = null; try { j = JSON.parse(text); } catch { }
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
      for (const p of arr) {
        const id = String(p?.id ?? p?.product_id ?? "");
        const nm = p?.name || p?.title;
        if (id && nm) map[id] = nm;
      }
      // If we got many names already, return
      if (Object.keys(map).length) return map;
    }
  } catch { }

  // Fallback: fetch individually
  for (const id of unique) {
    const urls = [
      `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/products/${encodeURIComponent(id)}`,
      `${SA_BASE}/products/${encodeURIComponent(id)}?shop_id=${CONFIG.SA_SHOP_ID}`,
      `${SA_BASE}/products/${encodeURIComponent(id)}`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers });
        const text = await r.text();
        if (debug) console.log(`[GET product ${id}] ${r.status} ${text.slice(0, 160)}...`);
        if (!r.ok) continue;
        let j = null; try { j = JSON.parse(text); } catch { }
        const nm = j?.name || j?.data?.name || j?.title;
        if (nm) { map[id] = nm; break; }
      } catch { }
    }
  }
  return map;
}

// Pull names from many possible shapes (+ use product-id backfill)
async function extractProductNamesRobust(invoiceJson, invoiceId, debug = false) {
  const names = [];

  // 1) Names already on invoice object
  const invItems =
    invoiceJson?.items ||
    invoiceJson?.data?.items ||
    invoiceJson?.invoice?.items ||
    invoiceJson?.line_items ||
    invoiceJson?.data?.line_items ||
    [];

  for (const it of invItems) {
    const n = it?.name || it?.product_name || it?.title || it?.sku;
    if (n) names.push(String(n));
  }

  // 2) Try the items/deliverables endpoints
  const extItems = await fetchInvoiceItems(invoiceId, debug);
  for (const it of extItems) {
    const n = it?.name || it?.product_name || it?.title || it?.sku;
    if (n) names.push(String(n));
  }

  // 3) If we still don’t have names, try to resolve product IDs
  const ids = [];
  const collectIds = (arr = []) => {
    for (const it of arr) {
      const pid = it?.product_id ?? it?.id ?? it?.productId ?? null;
      if (pid) ids.push(String(pid));
    }
  };
  collectIds(invItems);
  collectIds(extItems);

  if (!names.length && ids.length) {
    const nameMap = await fetchProductsByIds(ids, debug);
    for (const id of ids) if (nameMap[id]) names.push(nameMap[id]);
  }

  // 4) Last top-level fallbacks
  const fallback =
    invoiceJson?.name ||
    invoiceJson?.title ||
    invoiceJson?.product_name ||
    invoiceJson?.data?.product_name ||
    null;
  if (!names.length && fallback) names.push(String(fallback));

  return names.length ? names : ["Unknown Product"];
}

// Keep your categorizer, but prefer the first concrete name
function categorizeProduct(names) {
  // Join names, lower-case, replace non-alnum with spaces
  const raw = names.join(" ").toLowerCase();

  // Insert spaces between digit<->letter boundaries (e.g., "9500vp" -> "9500 vp")
  const spaced = raw
    .replace(/[^a-z0-9]+/g, " ")          // punctuation -> space
    .replace(/(\d)([a-z])/g, "$1 $2")     // 9v -> 9 v
    .replace(/([a-z])(\d)/g, "$1 $2")     // v9 -> v 9
    .trim();

  // Token list for easy includes checks
  const tokens = spaced.split(/\s+/);

  const has = (s) => spaced.includes(s);
  const hasToken = (t) => tokens.includes(t);

  // Robux / Roblox
  if (has("robux") || has("roblox")) {
    return { type: "robux", label: names[0] || "Robux" };
  }

  // V-Bucks (handle vbucks / v bucks / v-bucks)
  if (has("vbucks") || has("v bucks") || has("v-bucks") || has("fortnite")) {
    return { type: "vbucks", label: names[0] || "V-Bucks" };
  }

  // Valorant Points / VP (now catches "9500VP", "9,500 VP", etc.)
  if (has("valorant") || hasToken("vp") || has("valorant points")) {
    return { type: "vp", label: names[0] || "Valorant Points" };
  }

  // Fallback
  return { type: "generic", label: names[0] || "Your Item" };
}

// ---------- REDEEM by verifying + fetching deliverables (no POST) ----------
app.post("/api/redeem/:id", async (req, res) => {
  const debug = req.query.debug === "1" || req.query.debug === "true";
  const invoiceId = req.params.id;
  if (!invoiceId) return res.status(400).json({ ok: false, error: "Missing invoice id" });

  try {
    // 1) Fetch invoice
    const invUrl = `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}`;
    const invRsp = await getJson(invUrl, makeAuthHeaders(), debug);

    if (!invRsp.ok) {
      return res.status(invRsp.status || 502).json({
        ok: false,
        error: invRsp.text || `Invoice lookup failed (HTTP ${invRsp.status})`
      });
    }

    const status = invRsp.json?.status || invRsp.json?.data?.status || invRsp.json?.invoice?.status || "unknown";
    if (!isPaidLike(status)) {
      return res.json({
        ok: true,
        success: false,
        status,
        message: "Invoice is not paid/complete yet."
      });
    }

    // 2) Try to fetch deliverables/items (varies by shop)
    const candidates = [
      `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}/deliverables`,
      `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}/deliverables`,
      `${SA_BASE}/invoices/${encodeURIComponent(invoiceId)}/items`,
      `${SA_BASE}/shops/${CONFIG.SA_SHOP_ID}/invoices/${encodeURIComponent(invoiceId)}/items`
    ];

    let items = null, lastErr = null;
    for (const url of candidates) {
      try {
        const rsp = await getJson(url, makeAuthHeaders(), debug);
        if (!rsp.ok) { lastErr = new Error(rsp.text || `HTTP ${rsp.status}`); continue; }

        // Accept multiple shapes
        const arr =
          Array.isArray(rsp.json?.data) ? rsp.json.data :
            Array.isArray(rsp.json?.items) ? rsp.json.items :
              Array.isArray(rsp.json?.deliverables) ? rsp.json.deliverables :
                Array.isArray(rsp.json) ? rsp.json : [];

        if (arr && arr.length >= 0) { items = arr; break; }
      } catch (e) { lastErr = e; }
    }

    if (!items) {
      // Couldn’t fetch deliverables; still report paid status
      return res.json({
        ok: true,
        success: true,             // invoice is paid; treat as “redeemable”
        status,
        items: [],                // none returned
        note: lastErr ? String(lastErr.message || lastErr) : undefined
      });
    }

    // 3) Normalize a simple shape for the client
    const normalized = items.map(d => ({
      id: d.id || d.deliverable_id || d.item_id || null,
      sku: d.sku || d.product_sku || null,
      name: d.name || d.product_name || null,
      type: d.type || d.kind || null,
      code: d.code || d.license || d.key || null,
      content: d.content || d.payload || null,
      meta: d.meta || d.metadata || undefined,
    }));

    return res.json({
      ok: true,
      success: true,
      status,
      items: normalized
    });

  } catch (e) {
    console.error("[/api/redeem] error:", e);
    return res.status(502).json({ ok: false, success: false, error: e.message || String(e) });
  }
});



// ---------------------------- Debug helpers (optional) ----------------------------
app.get("/debug/sellauth/shops", async (_req, res) => {
  try {
    const r = await fetch(`${base}/shops`, { headers: { Authorization: `Bearer ${CONFIG.SA_API_KEY}` } });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/sellauth/invoice/:id", async (req, res) => {
  try {
    const data = await getInvoice(req.params.id);
    res.status(200).json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
});

// Raw-body webhook (MUST be before express.json for this route)
app.post(
  "/webhook/sellauth",
  express.raw({ type: "*/*", limit: "1mb" }),
  verifyWebhookSignatureMiddleware(),
  async (req, res) => {
    const eventId = req.get("X-Event-Id") || `${req.get(CONFIG.SIG_HEADER) || ""}:${req.body.length}`;
    if (seen(eventId)) return res.sendStatus(200);
    remember(eventId);

    let evt;
    try { evt = JSON.parse(req.body.toString("utf8")); }
    catch { return res.status(400).send("Invalid JSON"); }

    try {
      const type = String(evt?.type || "").toLowerCase();
      const invoiceId = evt?.data?.id || evt?.data?.invoiceId;
      const coinFromEvent = (evt?.data?.currency || evt?.data?.coin || "").toLowerCase() || null;

      const sku = evt?.data?.sku || evt?.data?.productSku || null;
      if (sku && (type.includes("paid") || type.includes("completed"))) decStockBySku(sku, 1);

      if (type.includes("invoice") && (type.includes("paid") || type.includes("completed"))) {
        if (invoiceId) { try { await getInvoice(invoiceId); } catch { } }
        const prefer = coinFromEvent && CONFIG.PAYOUT_CURRENCIES.includes(coinFromEvent) ? coinFromEvent : null;
        await autoWithdrawIfEligible(prefer);
      }

      res.sendStatus(200);
    } catch (e) {
      console.error("Webhook error:", e);
      res.status(500).send("Webhook processing failed");
    }
  }
);

// Fallback to index.html (single-page style)
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---------------------------- Start ----------------------------
(async function start() {
  console.log("Booting SellAuth bridge…");
  console.log("ENV:", {
    PORT: CONFIG.PORT,
    PUBLIC_URL: CONFIG.PUBLIC_URL,
    SA_API_BASE: CONFIG.SA_API_BASE,
    SA_SHOP_ID: CONFIG.SA_SHOP_ID,
    PAYOUT_CURRENCIES: CONFIG.PAYOUT_CURRENCIES,
  });
  if (typeof fetch !== "function") throw new Error("Global fetch not found (need Node 18+)");

app.get("/choose/:invoiceId", async (req, res) => {
  const debug = req.query.debug === "1";
  const invoiceId = req.params.invoiceId;

  // 🔒 If this invoice already chose a method, send them straight there.
  const locked = getChoice(invoiceId);
  if (locked === "giftcard") return res.redirect(302, `/fulfill/giftcard/${encodeURIComponent(invoiceId)}`);
  if (locked === "account")  return res.redirect(302, `/fulfill/account/${encodeURIComponent(invoiceId)}`);
  if (locked === "item")     return res.redirect(302, `/fulfill/item/${encodeURIComponent(invoiceId)}`);

  try {
    // 🔍 Step 2: Detect product type
    const inv   = await fetchInvoice(invoiceId, debug);
    const names = await extractProductNamesRobust(inv, invoiceId, debug);

    const cat   = categorizeProduct(names); // e.g. robux / vbucks / vp / generic

    // 🧭 Step 3: Build dynamic choice page
    const SHOW_CHOICES = ["robux", "vbucks", "vp"];
    const showTwo = SHOW_CHOICES.includes(cat.type);

    const giftcardUrl = `/fulfill/giftcard/${encodeURIComponent(invoiceId)}`;
    const accountUrl  = `/fulfill/account/${encodeURIComponent(invoiceId)}`;
    const genericUrl  = `/fulfill/item/${encodeURIComponent(invoiceId)}`;

    res.type("html").send(`
<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose Fulfillment — ${cat.label}</title>
<style>
  :root{
    --accent-red:#e53935; --accent-red-hover:#d32f2f;
    --bg:#0f0f0f; --panel:#161616; --panel-2:#1b1b1b; --border:#2a2a2a; --text:#f2f2f2; --muted:#a0a0a0;
  }
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:16px/1.45 Inter,system-ui,-apple-system,sans-serif}
  .wrap{max-width:780px;margin:32px auto;padding:24px;border:1px solid var(--border);border-radius:16px;background:var(--panel)}
  h1{font-size:28px;margin:0 0 8px}
  .sub{color:var(--muted);margin:0 0 20px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .one{display:block}
  .card{padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--panel-2)}
  .card h3{margin:0 0 8px}
  .muted{color:var(--muted)}
  .btn{display:inline-flex;align-items:center;justify-content:center;padding:.7rem 1.25rem;border-radius:999px;
       font-weight:700;text-decoration:none;background:var(--accent-red);color:#fff;transition:.2s}
  .btn:hover{background:var(--accent-red-hover)}
</style>
</head><body>
  <div class="wrap">
    <h1>${showTwo ? "Choose fulfillment" : "Get your item"}</h1>
    <p class="sub">Invoice <strong>${invoiceId}</strong> — Detected: <strong>${cat.label}</strong></p>

    ${
      showTwo
        ? `
          <div class="row">
            <div class="card">
              <h3>Gift Card</h3>
              <p class="muted">Receive a prepaid code you can redeem yourself.</p>
              <a class="btn" href="${giftcardUrl}">Get by Gift Card</a>
            </div>
            <div class="card">
              <h3>Account</h3>
              <p class="muted">We deliver using an account-based top-up or credential.</p>
              <a class="btn" href="${accountUrl}">Get by Account</a>
            </div>
          </div>
        `
        : `
          <div class="one">
            <div class="card">
              <h3>${cat.label}</h3>
              <p class="muted">Proceed to receive your item.</p>
              <a class="btn" href="${genericUrl}">Get your item</a>
            </div>
          </div>
        `
    }
  </div>
</body></html>
    `);
  } catch (e) {
    console.error("/choose error:", e);
    res.status(502).send("Unable to load invoice or choose page.");
  }
});

// Simple "pastebin-style" display page
function renderPastebinPage(title, content) {
  return `
<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --bg:#0f0f0f; --panel:#161616; --border:#2a2a2a;
    --text:#f2f2f2; --muted:#a0a0a0;
    --accent-red:#e53935; --accent-red-hover:#d32f2f;
  }
  body{background:var(--bg);color:var(--text);font:15px/1.45 Inter,system-ui,-apple-system,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{width:90%;max-width:720px;background:var(--panel);border:1px solid var(--border);
       border-radius:12px;padding:20px;box-shadow:0 0 20px #0004;}
  h1{font-size:24px;margin:0 0 12px}
  pre{background:#111;padding:15px;border-radius:8px;color:#e0e0e0;
      font-family:"JetBrains Mono","Courier New",monospace;white-space:pre-wrap;word-wrap:break-word;}
  .muted{color:var(--muted);font-size:13px;margin-top:8px;text-align:right}
  a.btn{display:inline-block;margin-top:16px;padding:.6rem 1.4rem;border-radius:999px;font-weight:700;text-decoration:none;
        background:var(--accent-red);color:#fff;transition:.2s;}
  a.btn:hover{background:var(--accent-red-hover);}
</style>
</head><body>
  <div class="box">
    <h1>${title}</h1>
    <pre>${content}</pre>
    <a class="btn" href="/">← Back to Home</a>
    <div class="muted">Geekky Automation — Vortic Bridge</div>
  </div>
</body></html>
  `;
}

function renderDeliveryPage(kind, invoiceId, cfg) {
  const title   = cfg?.title   || (kind === "giftcard" ? "Gift Card Delivery" : kind === "account" ? "Account Delivery" : "Your Item");
  const message = cfg?.message || (kind === "giftcard"
                      ? "Your prepaid code will appear below once processed."
                      : kind === "account"
                        ? "We’ll fulfill via account-based top-up or credentials."
                        : "Proceed to receive your item.");
  const output  = cfg?.output  || "Content/Instructions/Key here";

  const content = `
Invoice: ${invoiceId}

${message}

${output}
`.trim();

  return renderPastebinPage(title, content);
}

const customOutputs = {
  giftcard: {
    title: "Gift Card Delivery",
    message: "Your prepaid code will appear below once processed.",
    output: `EuuHvF986sJy-2dDSVLwhNOOf`
  },
  account: {
    title: "Account Delivery",
    message: "We’ll deliver via an account-based top-up or credentials.",
    output: `Username: VorticShop15
Password: xhV3plvt6SrP0L5`
  }
};

app.get("/fulfill/giftcard/:invoiceId", async (req, res) => {
  const invoiceId = req.params.invoiceId;
  const locked = getChoice(invoiceId);
  if (locked && locked !== "giftcard") {
    // Already locked to something else → bounce to the locked page
    const to =
      locked === "account" ? `/fulfill/account/${encodeURIComponent(invoiceId)}`
                           : `/fulfill/item/${encodeURIComponent(invoiceId)}`;
    return res.redirect(302, to);
  }
  // Lock to giftcard if not locked yet
  if (!locked) await setChoice(invoiceId, "giftcard");
  res.type("html").send(renderDeliveryPage("giftcard", invoiceId, customOutputs.giftcard));
});

app.get("/fulfill/account/:invoiceId", async (req, res) => {
  const invoiceId = req.params.invoiceId;
  const locked = getChoice(invoiceId);
  if (locked && locked !== "account") {
    const to =
      locked === "giftcard" ? `/fulfill/giftcard/${encodeURIComponent(invoiceId)}`
                            : `/fulfill/item/${encodeURIComponent(invoiceId)}`;
    return res.redirect(302, to);
  }
  if (!locked) await setChoice(invoiceId, "account");
  res.type("html").send(renderDeliveryPage("account", invoiceId, customOutputs.account));
});

// ---------------- Fixed outputs for "item" deliveries ----------------
const ITEM_FIXED_OUTPUTS = {
  rules: [
    // Nitro gift (actual gift link products)
    {
      any: ["nitro"],
      none: ["method"],
      cfg: {
        message: "Nitro delivery:",
        output: "https://discord.com/gifts/dskdfOAISdxcv"
      }
    },

    // Minecraft FA accounts
    {
      any: ["minecraft", "fa"],
      none: ["method"],
      cfg: {
        message: "Minecraft FA Account:",
        output: "Username: VorticShop20\nPassword: pZeerlHOg2wz4S8YKzavvLSZ"
      }
    },

    // Nitro Method (must contain the word 'method')
    {
      all: ["method", "nitro"],
      cfg: {
        message: "Nitro Method:",
        output: "https://mega.nz/folder/cm9wiZaR"
      }
    },

    // V-Bucks Method
    {
      all: ["method", "v-bucks"],
      any: ["v-bucks", "vbucks"],   // allow either spelling in the name
      cfg: {
        message: "V-Bucks Method:",
        output: "https://mega.nz/folder/cm9wiZaR"
      }
    },

    // Valorant Points Method
    {
      all: ["method", "valorant"],
      any: ["valorant points", "vp", "valorant"],
      cfg: {
        message: "Valorant Points Method:",
        output: "https://mega.nz/folder/cm9wiZaR"
      }
    },

    // Robux Method
    {
      all: ["method", "robux"],
      cfg: {
        message: "Robux Method:",
        output: "https://mega.nz/folder/cm9wiZaR"
      }
    },

    // Korblox account
    {
      any: ["korblox"],
      cfg: {
        message: "Korblox Account:",
        output: `Username: VorticShopHolder18
Password: rUYhfRHEgwFG4ERgLVIWgZ3v`
      }
    },

    // Headless account
    {
      any: ["headless"],
      cfg: {
        message: "Headless Account:",
        output: `Username: VorticShopHolder18
Password: rUYhfRHEgwFG4ERgLVIWgZ3v`
      }
    }
  ]
};

// Case-insensitive matcher: returns the first ITEM_FIXED_OUTPUTS rule that matches any product name
function chooseItemOutputByNames(productNames = []) {
  const namesLC = productNames.map(n => String(n || "").toLowerCase());

  const has = (needle) =>
    namesLC.some(name => name.includes(String(needle).toLowerCase()));

  const hasAll = (needles=[]) =>
    needles.every(needle => has(needle));

  const hasAny = (needles=[]) =>
    needles.length === 0 || needles.some(needle => has(needle));

  const hasNone = (needles=[]) =>
    needles.every(needle => !has(needle));

  const rules = ITEM_FIXED_OUTPUTS.rules || ITEM_FIXED_OUTPUTS.includes || [];
  for (const rule of rules) {
    const all  = rule.all  || [];
    const any  = rule.any  || rule.includes || []; // backward-compat with your old "includes"
    const none = rule.none || [];

    if (hasAll(all) && hasAny(any) && hasNone(none)) {
      return rule.cfg || null;  // { message, output, title? }
    }
  }
  return null;
}

// ---------- /fulfill/item uses fixed-output rules ----------
app.get("/fulfill/item/:invoiceId", async (req, res) => {
  const invoiceId = req.params.invoiceId;

  // Respect lock (can’t switch after first choice)
  const locked = getChoice(invoiceId);
  if (locked && locked !== "item") {
    const to =
      locked === "giftcard" ? `/fulfill/giftcard/${encodeURIComponent(invoiceId)}` :
      locked === "account"  ? `/fulfill/account/${encodeURIComponent(invoiceId)}`  :
                              `/fulfill/item/${encodeURIComponent(invoiceId)}`;
    return res.redirect(302, to);
  }

  // Lock if first visit
  if (!locked) await setChoice(invoiceId, "item");

  // Try to fetch invoice + names so we can match a rule
  let cfg = null;
  try {
    const debug = req.query.debug === "1" || req.query.debug === "true";
    const inv   = await fetchInvoice(invoiceId, debug);
    const names = await extractProductNamesRobust(inv, invoiceId, debug); // array of product names
    cfg = chooseItemOutputByNames(names);
  } catch (e) {
    // If SellAuth lookup fails, we’ll just fall back below.
    console.warn("Item fulfill: failed to resolve product names:", e?.message || e);
  }

  // If no rule matched, fall back to a generic message
  const fallback = {
    title:   "Your Item",
    message: "Proceed to receive your item.",
    output:  "Content/Instructions/Key here"
  };

  res.type("html").send(
    renderDeliveryPage("item", invoiceId, cfg || fallback)
  );
});

await loadChoices();
  app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`SellAuth bridge listening on ${CONFIG.PORT} (${CONFIG.PUBLIC_URL})`);
    console.log(`Health: http://localhost:${CONFIG.PORT}/health`);
    console.log(`Ping:   http://localhost:${CONFIG.PORT}/ping`);
  });
})();

