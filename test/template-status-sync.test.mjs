import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { extractTemplateEvents, syncTemplateEvents, commentFor } from "../src/template-status-sync.mjs";
import { handleDeliveryWebhook } from "../src/delivery-webhooks.mjs";

const WABA = "1919562838743064";
const ENV = { CLICKUP_API_TOKEN: "pk_test_token_123", CLICKUP_TEMPLATES_LIST_ID: "901821740548" };
const statusPayload = (event = "APPROVED", extra = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA, time: 1792944000, changes: [{ field: "message_template_status_update", value: {
    event, message_template_id: 2910531022636057, message_template_name: "reminder_oct",
    message_template_language: "ar", reason: "NONE", ...extra } }] }],
});

function fakeClickUp({ statusValue = null, templateId = "2910531022636057" } = {}) {
  const calls = [];
  const fields = [
    { id: "f-id", name: "Meta Template ID", type: "short_text" },
    { id: "f-status", name: "Meta Status", type: "drop_down", type_config: { options: [
      { id: "opt-pending", name: "Pending", orderindex: 0 }, { id: "opt-approved", name: "Approved", orderindex: 1 },
      { id: "opt-rejected", name: "Rejected", orderindex: 2 } ] } },
    { id: "f-cat", name: "Meta Category", type: "drop_down", type_config: { options: [
      { id: "opt-utility", name: "Utility", orderindex: 0 }, { id: "opt-marketing", name: "Marketing", orderindex: 1 } ] } },
  ];
  const tasks = [
    { id: "t1", custom_fields: [{ id: "f-id", value: templateId }, { id: "f-status", value: statusValue }] },
    { id: "t2", custom_fields: [{ id: "f-id", value: "999" }] },
  ];
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined,
      auth: options.headers?.Authorization });
    const json = url.endsWith("/field") ? { fields } : url.includes("/task?") ? { tasks, last_page: true } : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetch, calls };
}

test("extracts status and category events for the configured WABA only", () => {
  const payload = statusPayload("REJECTED", { reason: "INVALID_FORMAT" });
  payload.entry[0].changes.push({ field: "template_category_update", value: {
    message_template_id: 2910531022636057, message_template_name: "reminder_oct", previous_category: "UTILITY", new_category: "MARKETING" } });
  payload.entry.push({ id: "123", changes: payload.entry[0].changes });
  const events = extractTemplateEvents(payload, WABA);
  assert.equal(events.length, 2);
  assert.deepEqual([events[0].kind, events[0].event, events[0].reason], ["status", "REJECTED", "INVALID_FORMAT"]);
  assert.deepEqual([events[1].kind, events[1].category, events[1].previous], ["category", "MARKETING", "UTILITY"]);
  assert.equal(events[0].template_id, "2910531022636057");
});

test("ignores message delivery changes and malformed template ids", () => {
  const payload = statusPayload();
  payload.entry[0].changes.push({ field: "messages", value: { messaging_product: "whatsapp", statuses: [] } });
  payload.entry[0].changes.push({ field: "message_template_status_update", value: { event: "APPROVED", message_template_id: "abc" } });
  assert.equal(extractTemplateEvents(payload, WABA).length, 1);
});

test("updates Meta Status and comments on the matching task only", async () => {
  const { fetch, calls } = fakeClickUp();
  const result = await syncTemplateEvents(extractTemplateEvents(statusPayload(), WABA), ENV, { fetch });
  assert.equal(result.updated, 1);
  const writes = calls.filter(c => c.method === "POST");
  assert.equal(writes.length, 2);
  assert.match(writes[0].url, /\/task\/t1\/comment$/);
  assert.match(writes[0].body.comment_text, /reminder_oct is now APPROVED/);
  assert.match(writes[1].url, /\/task\/t1\/field\/f-status$/);
  assert.deepEqual(writes[1].body, { value: "opt-approved" });
  assert.ok(calls.every(c => c.auth === ENV.CLICKUP_API_TOKEN));
});

test("skips duplicate retries when the field already shows the status", async () => {
  const { fetch, calls } = fakeClickUp({ statusValue: 1 });
  const result = await syncTemplateEvents(extractTemplateEvents(statusPayload(), WABA), ENV, { fetch });
  assert.equal(result.updated, 0);
  assert.equal(calls.filter(c => c.method === "POST").length, 0);
});

test("a failed comment leaves the field untouched so Meta's retry posts both", async () => {
  const { fetch: base, calls } = fakeClickUp();
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/comment")) return { ok: false, status: 500, json: async () => ({}) };
    return base(url, options);
  };
  await assert.rejects(syncTemplateEvents(extractTemplateEvents(statusPayload(), WABA), ENV, { fetch }), e => e.retryable === true);
  assert.equal(calls.filter(c => c.method === "POST" && c.url.includes("/field/")).length, 0);
});

test("category update sets Meta Category", async () => {
  const { fetch, calls } = fakeClickUp();
  const payload = { object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "template_category_update",
    value: { message_template_id: "2910531022636057", message_template_name: "reminder_oct", previous_category: "UTILITY", new_category: "MARKETING" } }] }] };
  await syncTemplateEvents(extractTemplateEvents(payload, WABA), ENV, { fetch });
  const field = calls.find(c => c.method === "POST" && c.url.includes("/field/"));
  assert.deepEqual(field.body, { value: "opt-marketing" });
});

test("reports unmatched templates and does nothing without a token", async () => {
  const { fetch } = fakeClickUp({ templateId: "111" });
  const result = await syncTemplateEvents(extractTemplateEvents(statusPayload(), WABA), ENV, { fetch });
  assert.deepEqual(result.unmatched, ["2910531022636057"]);
  assert.equal((await syncTemplateEvents([{}], {}, { fetch })).skipped, "not_configured");
});

test("rejection comment carries Meta's reason", () => {
  const [ev] = extractTemplateEvents(statusPayload("REJECTED", { reason: "TAG_CONTENT_MISMATCH" }), WABA);
  assert.match(commentFor(ev), /Reason: TAG_CONTENT_MISMATCH/);
});

function signedRequest(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]);
  req.method = "POST";
  req.headers = { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") };
  return req;
}
function fakeRes() {
  return { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
}
const HOOK_ENV = { MCP_BEARER_TOKEN: "x".repeat(20), WHATSAPP_APP_SECRET: "app-secret", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify",
  WHATSAPP_WABA_ID: WABA, WHATSAPP_STATUS_FILE: "/tmp/never-used.json" };

test("webhook hands template events to the sync and acknowledges", async () => {
  let seen;
  const res = fakeRes();
  await handleDeliveryWebhook(signedRequest(statusPayload(), "app-secret"), res, new URL("http://x/webhooks/whatsapp"),
    HOOK_ENV, { ingest: async () => {} }, async events => { seen = events; });
  assert.equal(res.status, 200);
  assert.equal(seen[0].event, "APPROVED");
});

test("webhook asks Meta to retry on transient ClickUp failures only", async () => {
  const transient = fakeRes();
  await handleDeliveryWebhook(signedRequest(statusPayload(), "app-secret"), transient, new URL("http://x/webhooks/whatsapp"),
    HOOK_ENV, { ingest: async () => {} }, async () => { throw Object.assign(new Error("down"), { retryable: true }); });
  assert.equal(transient.status, 503);
  const permanent = fakeRes();
  await handleDeliveryWebhook(signedRequest(statusPayload(), "app-secret"), permanent, new URL("http://x/webhooks/whatsapp"),
    HOOK_ENV, { ingest: async () => {} }, async () => { throw new Error("bad token"); });
  assert.equal(permanent.status, 200);
});
