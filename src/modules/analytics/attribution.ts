import type { Hono } from "hono";
import type { createCustomers } from "../customers/public.js";
import type { createSourceViewing } from "../live/public.js";
export function attachAttributionSummary(app:Hono<{Variables:{merchantId:string;viewerId:string}}>,customers:ReturnType<typeof createCustomers>,viewing:ReturnType<typeof createSourceViewing>) {
 app.get("/api/merchant/attribution/summary",c=>c.json({ metrics:customers.stores(c.get("merchantId")).map(store=>({storeId:store.id,name:store.name,...viewing.metrics(customers.sourceCodes(String(store.id))),...customers.offlineMetrics(c.get("merchantId"),String(store.id))})), attribution:"first-valid-source-per-room-browser",conversionProven:false }));
}
