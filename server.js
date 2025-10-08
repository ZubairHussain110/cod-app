
import express from "express";
import { Pool } from "pg";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, APP_URL, DATABASE_URL, SCOPES } = process.env;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// DB (lazy) + SSL (Neon/Vercel)
let pool;
function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
  } catch (e) { console.error("ensureTables error:", e.message); }
}

// Shopify (lazy init)
let _shopify = null;
function getShopify() {
  if (_shopify) return _shopify;
  const HOST_NAME = (APP_URL || process.env.VERCEL_URL || "cod-app-omega.vercel.app")
    .toString().replace(/^https?:\/\//, "");
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) throw new Error("Missing SHOPIFY creds");
  _shopify = shopifyApi({
    apiKey: SHOPIFY_API_KEY,
    apiSecretKey: SHOPIFY_API_SECRET,
    apiVersion: ApiVersion.April24,
    scopes: (SCOPES || "read_products,read_customers,write_draft_orders").split(","),
    hostName: HOST_NAME,
    isEmbeddedApp: false,
  });
  return _shopify;
}

// Health & Privacy
app.get("/", (_req, res) => res.send("COD app is live."));
app.get("/privacy", (_req, res) => {
  res.type("html").send(`
    <h1>Privacy Policy — COD (Webixa Technology)</h1>
    <p>Contact: contact@webixatechnology.com</p>
    <p>We read products/customers and create draft orders. We store only shop access tokens in a secure database.</p>
    <p>On uninstall, email us to delete data. No payment information is processed by this app.</p>
  `);
});

// OAuth start
app.get("/auth", async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send("Missing shop");
    const shopify = getShopify();
    const url = await shopify.auth.oauth.begin({
      shop: shop.toString(),
      callbackPath: "/auth/callback",
      isOnline: false,
    });
    res.redirect(url);
  } catch (e) {
    console.error("auth begin error:", e);
    res.status(500).send("Auth start error: " + e.message);
  }
});

// OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    await ensureTablesSafe();
    const shopify = getShopify();
    const { session, scope } = await shopify.auth.oauth.callback({
      rawRequest: req, rawResponse: res,
    });
    const p = getPool();
    if (p) {
      await p.query(
        `insert into shop_sessions(shop, access_token, scope)
         values($1,$2,$3)
         on conflict(shop) do update set access_token=excluded.access_token, scope=excluded.scope`,
        [session.shop, session.accessToken, scope]
      );
    }
    res.redirect(`https://${session.shop}/admin/apps`);
  } catch (e) {
    console.error("auth callback error:", e);
    res.status(500).send("Auth callback error: " + e.message);
  }
});

// App Proxy: create Draft Order (Node18 global fetch)
app.post("/proxy/cod", async (req, res) => {
  try {
    await ensureTablesSafe();
    const shop = (req.query.shop || req.body.shop || "").toString();
    if (!shop) return res.status(400).json({ ok: false, error: "Missing shop" });

    const p = getPool(); if (!p) return res.status(500).json({ ok: false, error: "DB not configured" });
    const r = await p.query("select access_token from shop_sessions where shop=$1", [shop]);
    if (!r.rowCount) return res.status(401).json({ ok: false, error: "Shop not installed" });

    const accessToken = r.rows[0].access_token;
    const payload = {
      draft_order: {
        line_items: [{ title: "Cash on Delivery", quantity: 1, price: "0.00" }],
        note: "COD order",
        tags: ["COD","COD-App"]
      }
    };

    const resp = await fetch(`https://${shop}/admin/api/2024-04/draft_orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ ok: false, data });
    res.json({ ok: true, data });
  } catch (e) {
    console.error("proxy/cod error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// Vercel handler (no listen)
export default function handler(req, res) {
  return app(req, res);
}
export default function handler(req, res) {
  res.status(200).send("OK " + new Date().toISOString());
}
