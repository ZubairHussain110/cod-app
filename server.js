// api/server.js
const express = require("express");
const { Pool } = require("pg");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");

// -------- Env --------
const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  DATABASE_URL,
  SCOPES
} = process.env;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
  // Fail fast if critical secrets are missing
  console.error("Missing SHOPIFY_API_KEY/SHOPIFY_API_SECRET");
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------- Helpers --------
function getHostFromReq(req) {
  // Prefer Vercel/Proxy headers
  const xfHost = req.headers["x-forwarded-host"];
  const xfProto = req.headers["x-forwarded-proto"] || "https";
  const vercelUrl = process.env.VERCEL_URL; // e.g. my-app.vercel.app (no protocol)
  const baseFromEnv = (APP_URL || (vercelUrl && `https://${vercelUrl}`) || "").toString();

  // Priority: x-forwarded-host -> APP_URL/VERCEL_URL fallback
  const url = xfHost ? `${xfProto}://${xfHost}` : baseFromEnv;
  // Shopify SDK needs just the hostname (no protocol)
  return url.replace(/^https?:\/\//, "");
}

// -------- DB (lazy) --------
let pool;
function getPool() {
  if (!pool && DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Neon on Vercel
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
    console.error("ensureTables error:", e.message);
  }
}

// -------- Shopify (per-request host) --------
function makeShopify(hostName) {
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    throw new Error("Missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET");
  }

  return shopifyApi({
    apiKey:     SHOPIFY_API_KEY,
    apiSecretKey: SHOPIFY_API_SECRET,
    apiVersion: ApiVersion.April24, // update when you bump API versions
    scopes: (SCOPES || "read_products,read_customers,write_draft_orders")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
    hostName,             // must be hostname only (no protocol)
    isEmbeddedApp: false, // this app behaves as a standalone
  });
}

// -------- Basic routes --------
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("COD App (Express on Vercel) — OK");
});

app.get("/health", (_req, res) =>
  res.status(200).send("OK " + new Date().toISOString())
);

app.get("/privacy", (_req, res) => {
  res.type("html").send(`
    <h1>Privacy Policy — COD (Webixa Technology)</h1>
    <p>Contact: contact@webixatechnology.com</p>
    <p>We read products/customers and create draft orders. We store only shop access tokens in a secure database.</p>
    <p>On uninstall, email us to delete data. No payment information is processed by this app.</p>
  `);
});

// -------- OAuth start --------
app.get("/auth", async (req, res) => {
  try {
    const shop = (req.query.shop || "").toString().trim();
    if (!shop) return res.status(400).send("Missing shop");

    const hostName = getHostFromReq(req);
    const shopify = makeShopify(hostName);

    const url = await shopify.auth.oauth.begin({
      shop,
      callbackPath: "/auth/callback",
      isOnline: false,
    });

    res.redirect(url);
  } catch (e) {
    console.error("auth begin error:", e);
    res.status(500).send("Auth start error: " + (e.message || "Unknown"));
  }
});

// -------- OAuth callback --------
app.get("/auth/callback", async (req, res) => {
  try {
    await ensureTablesSafe();

    const hostName = getHostFromReq(req);
    const shopify = makeShopify(hostName);

    const { session, scope } = await shopify.auth.oauth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    const p = getPool();
    if (p) {
      await p.query(
        `insert into shop_sessions(shop, access_token, scope)
         values($1,$2,$3)
         on conflict(shop) do update
           set access_token=excluded.access_token,
               scope=excluded.scope`,
        [session.shop, session.accessToken, scope]
      );
    }

    // Send merchant back to Shopify admin
    res.redirect(`https://${session.shop}/admin/apps`);
  } catch (e) {
    console.error("auth callback error:", e);
    // If headers already sent by the SDK, avoid double send
    if (!res.headersSent) {
      res.status(500).send("Auth callback error: " + (e.message || "Unknown"));
    }
  }
});

// -------- App Proxy: Create Draft Order --------
app.post("/proxy/cod", async (req, res) => {
  try {
    await ensureTablesSafe();

    const shop = (req.query.shop || req.body.shop || "").toString().trim();
    if (!shop) return res.status(400).json({ ok: false, error: "Missing shop" });

    const p = getPool();
    if (!p) return res.status(500).json({ ok: false, error: "DB not configured" });

    const r = await p.query(
      "select access_token from shop_sessions where shop=$1",
      [shop]
    );
    if (!r.rowCount) return res.status(401).json({ ok: false, error: "Shop not installed" });

    const accessToken = r.rows[0].access_token;

    const payload = {
      draft_order: {
        line_items: [{ title: "Cash on Delivery", quantity: 1, price: "0.00" }],
        note: "COD order",
        tags: ["COD", "COD-App"],
      },
    };

    // Node 18+ has global fetch on Vercel
    const resp = await fetch(`https://${shop}/admin/api/2024-04/draft_orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, data });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("proxy/cod error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

// -------- Vercel handler (no app.listen) --------
module.exports = (req, res) => app(req, res);
