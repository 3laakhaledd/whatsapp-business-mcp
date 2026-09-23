import test from "node:test";
import assert from "node:assert/strict";
import { registerGenericTools, _internal } from "../src/tools/generic.mjs";

test("existing Graph allowlist remains unchanged", () => {
  for (const path of ["/123/message_templates", "/123/phone_numbers", "/123/messages", "/123/media",
    "/123/whatsapp_business_profile", "/123/subscribed_apps", "/123/owned_whatsapp_business_accounts",
    "/123", "/wamid.HBgLMzUx_abc-DEF"]) assert.equal(_internal.isAllowed(path), true);
  for (const path of ["/me", "/me/accounts", "/123/feed", "/123/ads", "/123/insights",
    "/oauth/access_token", "/debug_token", "/app/uploads", "/template_header_upload"]) assert.equal(_internal.isAllowed(path), false);
});
const tools = new Map();
registerGenericTools({ tool: (name, description, schema, annotations, handler) => tools.set(name, handler) });
test("dedicated tool and adapter registered without replacing messaging tools", () => {
  assert.deepEqual([...tools.keys()], ["wa_upload_template_image", "wa_api_call"]);
});
test("adapter is exact path, POST only, no query, valid JSON required", async () => {
  const handler = tools.get("wa_api_call");
  for (const args of [
    { method: "GET", path: "/template_header_upload" },
    { method: "DELETE", path: "/template_header_upload" },
    { method: "POST", path: "/template_header_upload", query_params: "access_token=x" },
    { method: "POST", path: "/template_header_upload", body_json: "{" },
    { method: "POST", path: "/template_header_upload/../messages" },
  ]) assert.equal((await handler(args)).isError, true);
});
test("compatibility adapter returns the header handle with no sends", async () => {
  process.env.WHATSAPP_TOKEN = "test-token-not-real";
  const originalFetch = globalThis.fetch;
  const calls = [];
  const responses = [{ id: "upload:abc" }, { h: "adapter-handle" }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = responses.shift();
    assert.ok(data, "unexpected extra request");
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    const result = await tools.get("wa_api_call")({
      method: "POST", path: "/template_header_upload",
      body_json: JSON.stringify({
        app_id: "123",
        file_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      }),
    });
    assert.equal(JSON.parse(result.content[0].text).header_handle, "adapter-handle");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => !c.url.includes("/messages")));
  } finally { globalThis.fetch = originalFetch; }
});
