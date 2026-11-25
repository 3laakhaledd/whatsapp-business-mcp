import { test } from "node:test";
import assert from "node:assert/strict";
import { pollConfig, pollTemplatesOnce, startTemplateStatusPoller } from "../src/template-status-poller.mjs";

const ENV = { CLICKUP_API_TOKEN: "pk_test_token_123", CLICKUP_TEMPLATES_LIST_ID: "901821740548", WHATSAPP_TOKEN: "meta-token" };

function fakeClickUp(taskFields) {
  const calls = [];
  const fields = [
    { id: "f-id", name: "Meta Template ID", type: "short_text" },
    { id: "f-status", name: "Meta Status", type: "drop_down", type_config: { options: [
      { id: "opt-pending", name: "Pending", orderindex: 0 }, { id: "opt-approved", name: "Approved", orderindex: 1 },
      { id: "opt-rejected", name: "Rejected", orderindex: 2 }, { id: "opt-deleted", name: "Deleted", orderindex: 3 } ] } },
    { id: "f-cat", name: "Meta Category", type: "drop_down", type_config: { options: [
      { id: "opt-utility", name: "Utility", orderindex: 0 }, { id: "opt-marketing", name: "Marketing", orderindex: 1 } ] } },
  ];
  const tasks = taskFields.map((custom_fields, i) => ({ id: `t${i + 1}`, custom_fields }));
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, auth: options.headers?.Authorization });
    const json = url.endsWith("/field") ? { fields } : url.includes("/task?") ? { tasks, last_page: true } : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetch, calls };
}
const pending = id => [{ id: "f-id", value: id }, { id: "f-status", value: "opt-pending" }, { id: "f-cat", value: "opt-utility" }];

test("config needs both tokens, honours off switch and enforces the minimum interval", () => {
  assert.equal(pollConfig({}), null);
  assert.equal(pollConfig({ ...ENV, WHATSAPP_TOKEN: "" }), null);
  assert.equal(pollConfig({ ...ENV, TEMPLATE_STATUS_POLL: "off" }), null);
  assert.equal(pollConfig(ENV).intervalMs, 60000);
  assert.equal(pollConfig({ ...ENV, TEMPLATE_STATUS_POLL_INTERVAL_MS: "1000" }).intervalMs, 30000);
});

test("approval and re-categorisation update both fields with one comment", async () => {
  const { fetch, calls } = fakeClickUp([pending("1788101516218170")]);
  const graphCalls = [];
  const graph = async (method, path) => { graphCalls.push([method, path]); return { id: "1788101516218170", name: "spen_workshops_reminder_nov_2026", status: "APPROVED", category: "MARKETING" }; };
  const result = await pollTemplatesOnce(ENV, { fetch, graph, now: () => 0 });
  assert.deepEqual(result, { checked: 1, updated: 1, errors: 0 });
  assert.deepEqual(graphCalls, [["GET", "/1788101516218170?fields=id,name,status,category"]]);
  const writes = calls.filter(c => c.method === "POST");
  assert.equal(writes.length, 3);
  assert.match(writes[0].url, /\/task\/t1\/comment$/);
  assert.match(writes[0].body.comment_text, /Meta Status changed from Pending to Approved; Meta Category changed from Utility to Marketing/);
  assert.match(writes[0].body.comment_text, /no messages were sent/);
  assert.deepEqual(writes.slice(1).map(w => [w.url.split("/field/")[1], w.body.value]), [["f-status", "opt-approved"], ["f-cat", "opt-marketing"]]);
  assert.ok(calls.every(c => c.auth === ENV.CLICKUP_API_TOKEN));
});

test("no writes when ClickUp already matches Meta", async () => {
  const { fetch, calls } = fakeClickUp([pending("123")]);
  const result = await pollTemplatesOnce(ENV, { fetch, graph: async () => ({ status: "PENDING", category: "UTILITY" }) });
  assert.equal(result.updated, 0);
  assert.equal(calls.filter(c => c.method === "POST").length, 0);
});

test("skips deleted templates and tasks without an ID, counts Meta errors without writing", async () => {
  const { fetch, calls } = fakeClickUp([
    [{ id: "f-id", value: "111" }, { id: "f-status", value: "opt-deleted" }],
    [{ id: "f-id", value: "" }],
    pending("222"),
  ]);
  const seen = [];
  const graph = async (m, path) => { seen.push(path); return { error: { kind: "auth" } }; };
  const result = await pollTemplatesOnce(ENV, { fetch, graph });
  assert.deepEqual(seen, ["/222?fields=id,name,status,category"]);
  assert.deepEqual(result, { checked: 1, updated: 0, errors: 1 });
  assert.equal(calls.filter(c => c.method === "POST").length, 0);
});

test("a failed comment leaves fields unchanged so the next minute retries", async () => {
  const { fetch: base, calls } = fakeClickUp([pending("333")]);
  const fetch = async (url, o = {}) => url.endsWith("/comment") ? { ok: false, status: 500, json: async () => ({}) } : base(url, o);
  await assert.rejects(pollTemplatesOnce(ENV, { fetch, graph: async () => ({ status: "REJECTED", category: "UTILITY" }) }));
  assert.equal(calls.filter(c => c.url.includes("/field/f-")).length, 0);
});

test("poller does not start without config and never overlaps runs", async () => {
  assert.equal(startTemplateStatusPoller({}), null);
  let active = 0, maxActive = 0, release;
  const gate = new Promise(r => { release = r; });
  const { fetch } = fakeClickUp([pending("444")]);
  const graph = async () => { active++; maxActive = Math.max(maxActive, active); await gate; active--; return { status: "PENDING", category: "UTILITY" }; };
  const poller = startTemplateStatusPoller(ENV, { fetch, graph, firstDelayMs: 1e9, log: () => {} });
  const a = poller.tick(); const b = poller.tick();
  release(); await a; await b;
  poller.stop();
  assert.equal(maxActive, 1);
  assert.equal(poller.intervalMs, 60000);
});
