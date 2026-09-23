import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { imageType } from "../template-upload.mjs";

// Chunked template-image upload: long base64 payloads get corrupted in single
// MCP calls, so the client sends small canonical-base64 chunks, the server
// reassembles, verifies SHA-256, and only then uploads to Meta's Resumable
// Upload API. Never creates templates and never sends messages.

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHUNKS = 256;
const MAX_CHUNK_CHARS = 8192;
const TTL_MS = 15 * 60 * 1000;
const sessions = new Map();

function sweepExpired(now = Date.now()) {
  for (const [id, s] of sessions) if (now > s.expiresAt) sessions.delete(id);
}

export function beginImageUpload({ expected_sha256, file_name, content_type, total_chunks }) {
  sweepExpired();
  if (typeof expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected_sha256)) {
    throw new Error("expected_sha256 must be a 64-char hex SHA-256.");
  }
  if (typeof file_name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file_name)) {
    throw new Error("file_name must be a simple filename of 1 to 128 characters.");
  }
  if (content_type !== "image/png" && content_type !== "image/jpeg") {
    throw new Error("content_type must be image/png or image/jpeg.");
  }
  if (!Number.isInteger(total_chunks) || total_chunks < 1 || total_chunks > MAX_CHUNKS) {
    throw new Error(`total_chunks must be an integer between 1 and ${MAX_CHUNKS}.`);
  }
  const id = randomBytes(24).toString("base64url");
  sessions.set(id, {
    expected: expected_sha256.toLowerCase(),
    fileName: file_name,
    contentType: content_type,
    total: total_chunks,
    chunks: new Array(total_chunks).fill(null),
    received: 0,
    expiresAt: Date.now() + TTL_MS,
  });
  return { upload_id: id, expires_at: new Date(Date.now() + TTL_MS).toISOString(), max_chunk_chars: MAX_CHUNK_CHARS, messages_sent: 0 };
}

export function addImageChunk({ upload_id, index, data }) {
  sweepExpired();
  const s = sessions.get(upload_id);
  if (!s) throw new Error("Upload session not found or expired.");
  if (typeof upload_id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(upload_id)) throw new Error("Invalid upload_id.");
  if (!Number.isInteger(index) || index < 0 || index >= s.total) throw new Error("Invalid chunk index.");
  if (typeof data !== "string" || !data.length || data.length > MAX_CHUNK_CHARS) {
    throw new Error(`data must be 1..${MAX_CHUNK_CHARS} base64 characters.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("data must be canonical base64.");
  const isLast = index === s.total - 1;
  if (!isLast && (data.includes("=") || data.length % 4 !== 0)) {
    throw new Error("Non-final chunks must be unpadded and a multiple of 4 characters.");
  }
  if (s.total > 1 && data.length % 4 !== 0) throw new Error("Chunks must be a multiple of 4 characters.");
  if (s.chunks[index] === null) s.received++;
  s.chunks[index] = data;
  return { received: s.received, total: s.total, complete: s.received === s.total, messages_sent: 0 };
}

export async function finalizeImageUpload({ upload_id, app_id }, deps = {}) {
  sweepExpired();
  const s = sessions.get(upload_id);
  if (!s) throw new Error("Upload session not found or expired.");
  if (s.received !== s.total) throw new Error(`Missing ${s.total - s.received} chunk(s).`);
  const b64 = s.chunks.join("");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.toString("base64") !== b64) {
    sessions.delete(upload_id);
    throw new Error("Reassembled payload failed canonical base64 validation; nothing was sent to Meta.");
  }
  if (!bytes.length || bytes.length > MAX_BYTES) {
    sessions.delete(upload_id);
    throw new Error("Image must contain 1 byte to 5 MiB.");
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== s.expected) {
    sessions.delete(upload_id);
    throw new Error("Checksum mismatch; upload aborted before reaching Meta.");
  }
  if (imageType(bytes) !== s.contentType) {
    sessions.delete(upload_id);
    throw new Error("Image bytes do not match the declared content_type.");
  }
  sessions.delete(upload_id);

  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN env var not set.");
  const version = process.env.WHATSAPP_API_VERSION || "v23.0";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Invalid WHATSAPP_API_VERSION.");
  const base = `https://graph.facebook.com/${version}`;
  let appId = app_id || process.env.WHATSAPP_APP_ID;
  if (appId && !/^\d+$/.test(appId)) throw new Error("app_id must be numeric.");
  const fetchFn = deps.fetch || globalThis.fetch;
  async function graph(path, options) {
    const res = await fetchFn(`${base}${path}`, { ...options, redirect: "error", signal: AbortSignal.timeout(60000) });
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
  const query = new URLSearchParams({ file_name: s.fileName, file_length: String(bytes.length), file_type: s.contentType });
  const session = await graph(`/${appId}/uploads?${query}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
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
    file_name: s.fileName,
    file_type: s.contentType,
    file_length: bytes.length,
    sha256: sha,
    app_id: appId,
    messages_sent: 0,
  };
}

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(error) {
  const known = /^(expected_sha256|file_name|content_type|total_chunks|Upload |Invalid |data |Non-final |Chunks |Missing |Reassembled |Image |Checksum |WHATSAPP_|Unable |Meta )/.test(error.message);
  return text({ error: known ? error.message : "Chunked image upload failed. Check the input, configuration, and Meta permissions." });
}

export function registerImageChunkTools(server) {
  server.registerTool(
    "wa_begin_template_image_upload",
    {
      title: "Begin chunked template image upload",
      description: "Start a chunked template-header image upload. Returns an upload_id valid for 15 minutes. Send the image base64 in small chunks via wa_add_template_image_chunk, then call wa_finalize_template_image_upload. Checksum-verified; never creates templates or sends messages.",
      inputSchema: {
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        file_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        content_type: z.enum(["image/png", "image/jpeg"]),
        total_chunks: z.number().int().min(1).max(MAX_CHUNKS),
      },
    },
    async (input) => {
      try { return text(beginImageUpload(input)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    "wa_add_template_image_chunk",
    {
      title: "Add one image chunk",
      description: "Append one canonical-base64 chunk to a chunked template-image upload. Non-final chunks must be unpadded and a multiple of 4 characters; keep each chunk under 8192 characters. Never sends messages.",
      inputSchema: {
        upload_id: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        index: z.number().int().min(0),
        data: z.string().min(1).max(MAX_CHUNK_CHARS),
      },
    },
    async (input) => {
      try { return text(addImageChunk(input)); } catch (error) { return fail(error); }
    },
  );

  server.registerTool(
    "wa_finalize_template_image_upload",
    {
      title: "Finalize chunked template image upload",
      description: "Reassemble all chunks, verify the exact SHA-256 and image type, then upload the bytes to Meta's Resumable Upload API and return a header_handle for an IMAGE template. Aborts before reaching Meta if the checksum mismatches. Never creates templates or sends messages.",
      inputSchema: {
        upload_id: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        app_id: z.string().regex(/^\d+$/).optional(),
      },
    },
    async (input) => {
      try { return text(await finalizeImageUpload(input)); } catch (error) { return fail(error); }
    },
  );
}
