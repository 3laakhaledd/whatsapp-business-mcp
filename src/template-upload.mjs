import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { createHash } from "node:crypto";

const MAX_BYTES = 5 * 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

export function validateSourceUrl(value) {
  const url = new URL(value);
  // No arbitrary remote fetches, credentials, redirects, or private addresses.
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !/^attachments\d*\.clickup\.com$/.test(url.hostname)) {
    throw new Error("file_url must be a direct HTTPS attachments.clickup.com image URL; otherwise use file_base64.");
  }
  return url;
}

export function isPublicV4(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function downloadImage(value) {
  const url = validateSourceUrl(value);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(a => !isPublicV4(a.address))) {
    throw new Error("Image host did not resolve exclusively to public addresses.");
  }
  const address = addresses[0].address;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      // Pin the validated address while preserving hostname/SNI/certificate checks.
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4),
      headers: { Accept: "image/png,image/jpeg" },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("Image download failed or redirected; use the direct file URL."));
        return;
      }
      if (Number(res.headers["content-length"] || 0) > MAX_BYTES) {
        req.destroy(new Error("Image exceeds 5 MiB."));
        return;
      }
      const chunks = [];
      let length = 0;
      res.on("data", chunk => {
        length += chunk.length;
        if (length > MAX_BYTES) req.destroy(new Error("Image exceeds 5 MiB."));
        else chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Image download interrupted.")));
    });
    const timer = setTimeout(() => req.destroy(new Error("Image download timed out.")), 30000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

export function decodeImage(value) {
  if (typeof value !== "string" || !value.length ||
      value.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("file_base64 must be canonical base64 of an image up to 5 MiB.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Invalid base64 encoding.");
  return bytes;
}

export function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) {
    throw new Error("Image must contain 1 byte to 5 MiB.");
  }
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG) &&
      bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  throw new Error("Only PNG and JPEG image bytes are supported.");
}

// Upload only: never creates templates or sends messages. Credentials stay server-side.
// deps exists for offline tests; it is not exposed through the MCP tool.
export async function uploadTemplateImage(input, deps = {}) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("An image upload object is required.");
    const allowed = new Set(["file_url", "file_base64", "file_name", "app_id"]);
    if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Unknown image upload field.");
    if (Boolean(input.file_url) === Boolean(input.file_base64)) throw new Error("Provide exactly one of file_url or file_base64.");
    let appId = input.app_id || process.env.WHATSAPP_APP_ID;
    if (appId && !/^\d+$/.test(appId)) throw new Error("app_id must be numeric.");
    const fileName = input.file_name || "template-header.png";
    if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName)) {
      throw new Error("file_name must be a simple filename of 1 to 128 characters.");
    }
    const bytes = input.file_url
      ? await (deps.download || downloadImage)(input.file_url)
      : decodeImage(input.file_base64);
    const mime = imageType(bytes);
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) throw new Error("WHATSAPP_TOKEN env var not set.");
    const version = process.env.WHATSAPP_API_VERSION || "v23.0";
    if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid WHATSAPP_API_VERSION.");
    const base = `https://graph.facebook.com/${version}`;
    const fetchFn = deps.fetch || globalThis.fetch;
    async function graph(path, options) {
      const res = await fetchFn(`${base}${path}`, {
        ...options, redirect: "error", signal: AbortSignal.timeout(60000),
      });
      let data;
      try { data = await res.json(); }
      catch { throw new Error(`Meta returned invalid JSON (HTTP ${res.status}).`); }
      if (!res.ok || data.error) {
        const error = new Error(`Meta upload request failed (HTTP ${res.status}, code ${data.error?.code || "unknown"}).`);
        error.http_status = res.status;
        error.code = data.error?.code;
        throw error;
      }
      return data;
    }
    if (!appId) {
      const app = await graph("/app?fields=id", { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      if (typeof app.id !== "string" || !/^\d+$/.test(app.id)) throw new Error("Unable to identify app; supply app_id or WHATSAPP_APP_ID.");
      appId = app.id;
    }
    const query = new URLSearchParams({
      file_name: fileName, file_length: String(bytes.length), file_type: mime,
    });
    const session = await graph(`/${appId}/uploads?${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    // Session IDs can include an opaque signed query string. Keep them verbatim,
    // but disallow authority/path separators and fragments.
    if (typeof session.id !== "string" ||
        !/^upload:[A-Za-z0-9_:=?&%+.-]+$/.test(session.id) ||
        /[\r\n\/\\#]/.test(session.id)) throw new Error("Meta returned an invalid upload session.");
    const result = await graph(`/${session.id}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (typeof result.h !== "string" || !result.h.length) throw new Error("Meta did not return a template header handle.");
    return {
      header_handle: result.h,
      file_name: fileName,
      file_type: mime,
      file_length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      app_id: appId,
      messages_sent: 0,
    };
  } catch (error) {
    // Never return fetch URLs, access tokens, binary data, or upstream response bodies.
    const known = /^(file_|Image |Only |Invalid |Unknown |Provide |app_id |An image |WHATSAPP_|Unable |Meta )/.test(error.message);
    return { error: {
      kind: "template_upload_error",
      message: known ? error.message : "Image upload failed. Check the source, configuration, and Meta permissions.",
      ...(error.http_status ? { http_status: error.http_status, code: error.code } : {}),
    } };
  }
}
