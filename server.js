import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Pool } from "pg";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  DATABASE_URL
} = process.env;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !DATABASE_URL) {
  console.warn("Missing ENV. Required: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL, APP_URL");
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DB (Vercel Postgres / Neon)
const pool = new Pool({ connectionString: DATABASE_URL });

const ensureTables = async () => {
  await pool.query(`
    create table if not exists shop_sessions(
      shop text primary key,
      access_token text not null,
      scope text,
      created_at timestamptz default now()
    );
  `);
};
ensureTables();

// --- Shopify SDK
const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  scopes: ["read_products", "read_customers", "write_draft_orders"],
  hostName: (APP_URL || "example.com").replace(/^https?:\/\//, ""),
  apiVersion: ApiVersion.July25,
  isEmbeddedApp: true
});

// ---------- OAuth start
app.get("/auth", async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");
  const authRoute = await shopify.auth.oauth.begin({
    shop: shop.toString(),
    callbackPath: "/auth/callback",
    isOnline: false
  });
  res.redirect(authRoute);
});

// ---------- OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    const { session, scope } = await shopify.auth.oauth.callback({
      rawRequest: req,
      rawResponse: res
    });
    await pool.query(
      `insert into shop_sessions(shop, access_token, scope)
       values($1,$2,$3)
       on conflict(shop) do update set access_token=excluded.access_token, scope=excluded.scope`,
      [session.shop, session.accessToken, scope]
    );
    return res.redirect(\`https://\${session.shop}/admin/apps\`);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Auth error");
  }
});

// ---------- Health / Privacy
app.get("/", (_req, res) => res.send("COD app is live."));
app.get("/privacy", (_req, res) =>
  res.type("html").send(`
  <h1>Privacy Policy — COD (Webixa Technology)</h1>
  <p>Contact: contact@webixatechnology.com</p>
  <p>We read products/customers, create draft orders, and store minimal config & tokens.</p>
  <p>Uninstall → email us for deletion. No card data. TLS enforced.</p>
`));

// ---------- App Proxy target (verify HMAC + Draft Order Create)
function verifyProxyHmac(query, secret) {
  const { hmac, ...rest } = query;
  const msg = Object.keys(rest)
    .sort()
    .map(k => \`\${k}=\${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}\`)
    .join("&");
  const digest = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac, "utf-8"));
  } catch {
    return false;
  }
}

app.post("/proxy/cod", async (req, res) => {
  try {
    if (!verifyProxyHmac(req.query, SHOPIFY_API_SECRET))
      return res.status(403).json({ ok: false, error: "Bad HMAC" });

    const shop = req.query.shop;
    const result = await pool.query("select access_token from shop_sessions where shop=$1", [shop]);
    if (!result.rowCount) return res.status(401).json({ ok: false, error: "Shop not installed" });
    const accessToken = result.rows[0].access_token;

    const {
      lineItems = [],
      customer = {},
      shippingAddress = {},
      note = "COD order",
      codFee = 0
    } = req.body || {};

    const draftInput = {
      note,
      tags: ["COD", "COD-App"],
      email: customer.email || null,
      shippingAddress,
      billingAddress: shippingAddress,
      customer: customer.email ? { email: customer.email } : undefined,
      lineItems: lineItems.map(li => ({
        variantId: li.variantId,
        quantity: parseInt(li.quantity || "1", 10)
      })),
    };

    const gql = `#graphql
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl name }
          userErrors { field message }
        }
      }`;

    const resp = await fetch(\`https://\${shop}/admin/api/2025-07/graphql.json\`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: gql, variables: { input: draftInput } })
    }).then(r => r.json());

    if (resp.errors) return res.status(400).json({ ok: false, errors: resp.errors });
    const ue = resp.data?.draftOrderCreate?.userErrors;
    if (ue && ue.length) return res.status(400).json({ ok: false, errors: ue });

    const draft = resp.data.draftOrderCreate.draftOrder;
    return res.json({ ok: true, draftOrderId: draft.id, invoiceUrl: draft.invoiceUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(\`COD app listening on \${port}\`));
