import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Pool } from "pg";
import { shopifyApi, ApiVersion } from "@shopify/shopify-api";

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  APP_URL,
  DATABASE_URL,
  SCOPES
} = process.env;

if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !DATABASE_URL) {
  console.warn("Missing ENV. Required: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, DATABASE_URL, APP_URL");
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Neon / Postgres
const pool = new Pool({
  connectionString: DATABASE_URL,
});

const ensureTables = async () => {
  await pool.query(`
    create table if not exists shop_sessions (
      shop text primary key,
      access_token text not null,
      scope text,
      created_at timestamptz default now()
    )
  `);
};
ensureTables();

// --- Shopify API setup
const shopify = shopifyApi({
  apiKey: SHOPIFY_API_KEY,
  apiSecretKey: SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.April24,
  scopes: (SCOPES || "read_products,read_customers,write_draft_orders").split(","),
  hostName: APP_URL.replace(/^https?:\/\//, ""),
  isEmbeddedApp: false,
});

// --- OAuth start
app.get("/auth", async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop param");
  const authUrl = await shopify.auth.begin({
    shop,
    callbackPath: "/auth/callback",
    isOnline: false,
  });
  res.redirect(authUrl);
});

// --- OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, accessToken, scope } = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    await pool.query(
      "insert into shop_sessions (shop, access_token, scope) values ($1, $2, $3) on conflict (shop) do update set access_token=$2, scope=$3",
      [shop, accessToken, scope]
    );
    res.send("App installed successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Auth callback error");
  }
});

// --- Proxy: Create Draft Order
app.post("/proxy/cod", async (req, res) => {
  try {
    const { shop } = req.body;
    const result = await pool.query("select access_token from shop_sessions where shop=$1", [shop]);
    if (!result.rows.length) return res.status(401).send("Shop not found");

    const accessToken = result.rows[0].access_token;
    const draftOrder = {
      draft_order: {
        line_items: [{ title: "Cash on Delivery", price: "0.00" }],
        note: "COD Order",
      },
    };

    const response = await fetch(`https://${shop}/admin/api/2024-04/draft_orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draftOrder),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error creating draft order");
  }
});

// --- Privacy page
app.get("/privacy", (req, res) => {
  res.send(`
    <h2>Privacy Policy</h2>
    <p>This app does not store any personal data except necessary authentication tokens.</p>
  `);
});

// --- Serverless export (IMPORTANT)
export default app;
