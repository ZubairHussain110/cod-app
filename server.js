// --- Imports (ESM)
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Pool } from "pg";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

// --- ENV
const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  DATABASE_URL,
  SCOPES,
} = process.env;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !APP_URL) {
  console.warn("Missing ENV: SHOPIFY_API_KEY / SHOPIFY_API_SECRET / APP_URL");
}

// --- App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DB (lazy, with SSL so Neon works on Vercel)
let pool;
function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // <-- important for Neon on Vercel
    });
  }
  return pool;
}

async function ensureTablesSafe() {
  try {
    const p = getPool();
    if (!p) return;
    await p.query(`
      create table if not exists shop_sessions(
        shop text primary key,
        access_token text not null,
        scope text,
        created_at timestamptz default now()
      );
    `);
  } catch (e) {
    console.error("ensureTables error (non-fatal):", e.message);
  }
}

// --- Shopify SDK config
const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.April24, // stable
  scopes: (SCOPES || "read_products,read_customers,write_draft_orders").split(","),
  hostName: APP_URL.replace(/^https?:\/\//, ""),
  isEmbeddedApp: false,
});

// ---------- Health & Privacy (should never crash)
app.get("/", (_req, res) => res.send("COD app is live."));
app.get("/privacy", (_req, res) => {
  res.type("html").send(`
    <h1>Privacy Policy — COD (Webixa Technology)</h1>
    <p>Contact: contact@webixatechnology.com</p>
    <p>We read products/customers and create draft orders. We store only shop access tokens in a secure database.</p>
    <p>On uninstall, email us to delete data. No payment card data is processed by this app.</p>
  `);
});

// ---------- OAuth start
app.get("/auth", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send("Missing shop");
    const url = await shopify.auth.begin({
      shop: shop.toString(),
      callbackPath: "/auth/callback",
      isOnline: false,
    });
    res.redirect(url);
  } catch (e) {
    console.error("auth begin error:", e);
    res.status(500).send("Auth start error");
  }
});

// ---------- OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    await ensureTablesSafe();
    const { shop, accessToken, scope } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    const p = getPool();
    if (p) {
      await p.query(
        `insert into shop_sessions(shop, access_token, scope)
         values($1,$2,$3)
         on conflict(shop) do update set access_token=excluded.access_token, scope=excluded.scope`,
        [shop, accessToken, scope]
      );
    }
    res.redirect(`https://${shop}/admin/apps`);
  } catch (e) {
    console.error("auth callback error:", e);
    res.status(500).send("Auth callback error");
  }
});

// ---------- App Proxy endpoint: create Draft Order
app.post("/proxy/cod", async (req, res) => {
  try {
    await ensureTablesSafe();
    const { shop } = req.query;          // App Proxy will add ?shop=xxx
    if (!shop) return res.status(400).json({ ok: false, error: "Missing shop" });

    const p = getPool();
    if (!p) return res.status(500).json({ ok: false, error: "DB not configured" });
    const r = await p.query("select access_token from shop_sessions where shop=$1", [shop]);
    if (!r.rowCount) return res.status(401).json({ ok: false, error: "Shop not installed" });

    const accessToken = r.rows[0].access_token;

    const draftInput = {
      draft_order: {
        line_items: [{ title: "Cash on Delivery", quantity: 1, price: "0.00" }],
        note: "COD order",
        tags: ["COD", "COD-App"],
      },
    };

    const resp = await fetch(`https://${shop}/admin/api/2024-04/draft_orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draftInput),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ ok: false, data });

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("proxy/cod error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// --- Serverless export (no app.listen)
export default app;
