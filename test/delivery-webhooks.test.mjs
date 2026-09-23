import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DeliveryStore, extractStatuses, validSignature, deliveryConfig, handleDeliveryWebhook, getDeliveryStatus } from "../src/delivery-webhooks.mjs";
const env = { MCP_BEARER_TOKEN: "test-auth", WHATSAPP_APP_SECRET: "test-secret", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify", WHATSAPP_WABA_ID: "123", WHATSAPP_STATUS_FILE: "/tmp/test-delivery.json" };
const event = (status = "failed", timestamp = "100") => ({ object: "whatsapp_business_account", entry: [{ id: "123", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "456" }, statuses: [{ id: "wamid.test", status, timestamp, recipient_id: "201234567890", errors: status === "failed" ? [{ code: 131053, title: "Media error", error_data: { details: "Image download failed" } }] : [] }] } }] }] });
const sign = body => "sha256=" + createHmac("sha256", env.WHATSAPP_APP_SECRET).update(body).digest("hex");
test("raw-body signature validation fails closed", () => {
  const raw = Buffer.from(JSON.stringify(event()));
  assert.equal(validSignature(raw, sign(raw), env.WHATSAPP_APP_SECRET), true);
  assert.equal(validSignature(Buffer.concat([raw, Buffer.from(" ")]), sign(raw), env.WHATSAPP_APP_SECRET), false);
  assert.equal(validSignature(raw, "sha256=00", env.WHATSAPP_APP_SECRET), false);
  assert.equal(validSignature(raw, sign(raw), ""), false);
  assert.equal(deliveryConfig(env), true);
  for (const key of Object.keys(env)) assert.equal(deliveryConfig({ ...env, [key]: "" }), false);
});
test("only scoped status events and error details, no message bodies or recipient", () => {
  assert.equal(extractStatuses(event(), "999").length, 0);
  const rows = extractStatuses(event(), "123");
  assert.equal(rows[0].errors[0].code, 131053);
  assert.equal(rows[0].errors[0].details, "Image download failed");
  assert.equal("recipient_id" in rows[0], false);
  assert.deepEqual(extractStatuses({ object: "other" }, "123"), []);
  assert.deepEqual(extractStatuses({ object: "whatsapp_business_account", entry: [null] }, "123"), []);
});
test("persistence, deduplication, ordering, concurrency, scope, retention and permissions", async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wa-delivery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, "status.json"); let now = Date.now();
  const store = new DeliveryStore(file, () => now);
  await store.ingest(extractStatuses(event("read", "300"), "123"));
  await Promise.all([store.ingest(extractStatuses(event("sent", "100"), "123")), store.ingest(extractStatuses(event("delivered", "200"), "123")), store.ingest(extractStatuses(event("read", "300"), "123"))]);
  const restarted = new DeliveryStore(file, () => now), row = await restarted.get("wamid.test", "123");
  assert.equal(row.latest.status, "read"); assert.equal(row.history.length, 3);
  assert.equal(await restarted.get("wamid.test", "999"), null);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await getDeliveryStatus("wamid.test", { ...env, WHATSAPP_STATUS_FILE: file })).status, "read");
  assert.equal((await getDeliveryStatus("wamid.missing", { ...env, WHATSAPP_STATUS_FILE: file })).status, "unknown");
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(await restarted.get("wamid.test", "123"), null);
  await restarted.ingest([]); assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), []);
});
async function serve(t, store, config = env) {
  const server = createServer((req, res) => { handleDeliveryWebhook(req, res, new URL(req.url, "http://localhost"), config, store).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/webhooks/whatsapp`;
}
test("HTTP verification, signed receipts, bad signatures, malformed JSON and unrelated WABA", async t => {
  const stored = [], url = await serve(t, { ingest: async rows => stored.push(...rows) });
  let r = await fetch(url + "?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345");
  assert.equal(r.status, 200); assert.equal(await r.text(), "12345");
  assert.equal((await fetch(url + "?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345")).status, 403);
  const body = JSON.stringify(event());
  const send = (body, signature = sign(body)) => fetch(url, { method: "POST", body, headers: { "x-hub-signature-256": signature } });
  assert.equal((await send(body)).status, 200); assert.equal(stored.length, 1);
  assert.equal((await send(body + " ", sign(body))).status, 401);
  assert.equal((await fetch(url, { method: "POST", body })).status, 401);
  assert.equal((await send("{")).status, 400);
  assert.equal((await send(body.replace('"123"', '"999"'))).status, 200);
  assert.equal(stored.length, 1); assert.equal((await fetch(url, { method: "PUT" })).status, 405);
});
test("oversized request and storage/configuration failures fail closed", async t => {
  const url = await serve(t, { ingest: async () => { throw new Error("disk full"); } });
  const body = JSON.stringify(event());
  const send = value => fetch(url, { method: "POST", body: value, headers: { "x-hub-signature-256": sign(value) } });
  assert.equal((await send(body)).status, 503);
  assert.equal((await send("x".repeat(1024 * 1024 + 1))).status, 413);
  const disabled = await serve(t, {}, {});
  assert.equal((await fetch(disabled)).status, 503);
  assert.equal((await getDeliveryStatus("wamid.test", {})).status, "not_configured");
});
