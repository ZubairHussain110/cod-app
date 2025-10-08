# COD — Shopify Cash on Delivery Order Form

Public Shopify app using Draft Orders via App Proxy. No localhost needed — deploy on Vercel.

**Routes**
- `/auth` → start OAuth
- `/auth/callback` → finish OAuth
- `/proxy/cod` (POST) → create Draft Order from storefront form
- `/privacy` → privacy policy page

**ENV**
- SHOPIFY_API_KEY
- SHOPIFY_API_SECRET
- SCOPES=read_products,write_draft_orders,read_customers
- APP_URL=https://your-vercel-url
- DATABASE_URL=postgres connection string
