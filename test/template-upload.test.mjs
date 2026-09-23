import test from "node:test";
import assert from "node:assert/strict";
import { uploadTemplateImage, validateSourceUrl, isPublicV4, decodeImage, imageType } from "../src/template-upload.mjs";
import { createUploadSession, consumeUpload } from "../src/template-upload-browser.mjs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

process.env.WHATSAPP_TOKEN = "test-token-not-real";
delete process.env.WHATSAPP_APP_ID;
process.env.MCP_UPLOAD_SECRET = "0123456789abcdef";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
const input = { file_base64: png.toString("base64"), app_id: "123", file_name: "reminder.png" };
function fakeGraph(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    const data = responses.shift();
    assert.ok(data, "Unexpected extra request");
    return { ok: !data.error, status: data.error ? 400 : 200, json: async () => data };
  };
}

test("two-stage upload uses byte length, raw bytes, OAuth and zero offset", async () => {
  const calls = [];
  const result = await uploadTemplateImage(input, { fetch: fakeGraph([{ id: "upload:abc?sig=def" }, { h: "real-handle" }], calls) });
  assert.equal(result.header_handle, "real-handle");
  assert.equal(result.file_length, png.length);
  assert.equal(result.messages_sent, 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(new URL(calls[0].url).searchParams.get("file_length"), String(png.length));
  assert.equal(new URL(calls[0].url).searchParams.get("file_type"), "image/png");
  assert.equal(calls[1].url, "https://graph.facebook.com/v23.0/upload:abc?sig=def");
  assert.deepEqual(calls[1].options.body, png);
  assert.equal(calls[1].options.headers.Authorization, "OAuth test-token-not-real");
  assert.equal(calls[1].options.headers.file_offset, "0");
  assert.ok(calls.every(c => !c.url.includes("messages")));
  assert.ok(calls.every(c => c.options.redirect === "error"));
});

test("token's app is discovered when app_id is omitted", async () => {
  const calls = [];
  const result = await uploadTemplateImage({ file_base64: input.file_base64 }, {
    fetch: fakeGraph([{ id: "456" }, { id: "upload:abc" }, { h: "handle" }], calls),
  });
  assert.equal(result.app_id, "456");
  assert.equal(calls[0].url, "https://graph.facebook.com/v23.0/app?fields=id");
  assert.match(calls[1].url, /\/456\/uploads\?/);
});

test("trusted URL downloader output is uploaded as bytes", async () => {
  const result = await uploadTemplateImage({ file_url: "https://attachments.clickup.com/image.png", app_id: "123" }, {
    download: async url => { validateSourceUrl(url); return png; },
    fetch: fakeGraph([{ id: "upload:abc" }, { h: "handle" }]),
  });
  assert.equal(result.file_type, "image/png");
});

test("only trusted HTTPS image hosts accepted", () => {
  assert.equal(validateSourceUrl("https://attachments.clickup.com/a.png").hostname, "attachments.clickup.com");
  for (const url of ["http://attachments.clickup.com/a", "https://127.0.0.1/a",
    "https://169.254.169.254/", "https://evil.com/", "https://attachments.clickup.com.evil.com/a",
    "https://user:pass@attachments.clickup.com/a", "https://attachments.clickup.com:8080/a"]) {
    assert.throws(() => validateSourceUrl(url));
  }
});

test("private and reserved DNS results rejected", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "198.19.0.1", "192.0.2.1", "203.0.113.1", "224.0.0.1", "::1"]) assert.equal(isPublicV4(ip), false);
  assert.equal(isPublicV4("8.8.8.8"), true);
});

test("invalid inputs fail before any Graph request", async () => {
  for (const bad of [null, [], {}, { ...input, file_url: "https://attachments.clickup.com/a" },
    { ...input, app_id: "../messages" }, { ...input, file_name: "../x.png" },
    { ...input, access_token: "injected" }, { ...input, file_base64: "data:image/png;base64,abc" },
    { ...input, file_base64: Buffer.from("<html>no</html>").toString("base64") }]) {
    const result = await uploadTemplateImage(bad, { fetch: () => assert.fail("Should not call Graph") });
    assert.ok(result.error);
  }
});

test("strict base64 and size limits", () => {
  for (const value of ["", "====", "a===", "aA==\n", "aB==", "a".repeat(8 * 1024 * 1024)]) assert.throws(() => decodeImage(value));
  assert.deepEqual(decodeImage(input.file_base64), png);
  assert.throws(() => imageType(Buffer.alloc(5 * 1024 * 1024 + 1)));
});

test("upstream errors stop upload and do not expose sensitive bodies", async () => {
  const calls = [];
  const result = await uploadTemplateImage(input, {
    fetch: fakeGraph([{ error: { code: 190, message: "test-token-not-real sensitive details" } }], calls),
  });
  assert.ok(result.error);
  assert.equal(calls.length, 1);
  assert.equal(result.error.code, 190);
  assert.ok(!JSON.stringify(result).includes("test-token-not-real"));
});

test("unsafe session IDs cannot redirect authenticated uploads", async () => {
  for (const id of ["https://evil.com", "//evil.com", "upload:../messages", "upload:a#fragment", "upload:a\r\nx"]) {
    const calls = [];
    const result = await uploadTemplateImage(input, { fetch: fakeGraph([{ id }], calls) });
    assert.ok(result.error);
    assert.equal(calls.length, 1);
  }
});

test("missing handle is not reported as success", async () => {
  const result = await uploadTemplateImage(input, { fetch: fakeGraph([{ id: "upload:abc" }, { success: true }]) });
  assert.ok(result.error);
});

test("raw network exceptions are sanitized", async () => {
  const result = await uploadTemplateImage(input, { fetch: async () => { throw new Error("token=test-token-not-real"); } });
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes("test-token-not-real"));
});

test("one-use upload link verifies checksum before intake", async () => {
  const sha256 = createHash("sha256").update(png).digest("hex");
  const session = createUploadSession({ expectedSha256: sha256, fileName: "reminder.png", contentType: "image/png" });
  const req = new Readable();
  req._read = () => {};
  req.push(png);
  req.push(null);
  const result = await consumeUpload(req, session.token);
  assert.deepEqual(result.bytes, png);
  assert.equal(result.sha256, sha256);
  await assert.rejects(() => consumeUpload(Readable.from([png]), session.token));
});
