import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/*
 * Single Railway replica. Mount a persistent volume at /data and set:
 * WHATSAPP_STATUS_FILE=/data/whatsapp-delivery.json
 * WHATSAPP_WABA_ID=<WABA ID>
 * WHATSAPP_APP_SECRET=<Meta app secret, NOT the access token>
 * WHATSAPP_WEBHOOK_VERIFY_TOKEN=<new random secret>
 * MCP_BEARER_TOKEN=<existing MCP authentication secret>
 * Meta: configure https://<host>/webhooks/whatsapp with the verify token,
 * subscribe to whatsapp_business_account's messages field and subscribe
 * the app to the WABA. Deploying does NOT configure Meta or send messages.
 * No backfill. Keep one replica: use a shared database before scaling.
 * All clients sharing the MCP bearer can read this WABA's delivery receipts.
 * Retention: 7 days, at most 1,000 messages and 10 events per message.
 */
const MAX_BODY = 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const TTL = 7 * 24 * 60 * 60 * 1000;
const ORDER = { sent: 1, failed: 2, delivered: 3, read: 4 };
const clip = v => typeof v === "string" ? v.slice(0, 256) : undefined;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function validSignature(raw, signature, secret) {
  if (!secret || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(raw).digest(), Buffer.from(signature.slice(7), "hex"));
}
export function deliveryConfig(env = process.env) {
  return Boolean(env.MCP_BEARER_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
    /^\d+$/.test(env.WHATSAPP_WABA_ID || "") && isAbsolute(env.WHATSAPP_STATUS_FILE || ""));
}
export function extractStatuses(payload, wabaId) {
  const events = [];
  if (payload?.object !== "whatsapp_business_account") return events;
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    if (entry?.id !== wabaId) continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== "messages" || value?.messaging_product !== "whatsapp") continue;
      const phone = value.metadata?.phone_number_id;
      if (typeof phone !== "string" || !/^\d+$/.test(phone)) continue;
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof s?.id !== "string" || !s.id.startsWith("wamid.") || s.id.length > 512 ||
            !Object.hasOwn(ORDER, s.status) || !/^\d{1,12}$/.test(String(s.timestamp))) continue;
        events.push({ id: s.id, waba_id: wabaId, phone_number_id: phone, status: s.status, timestamp: Number(s.timestamp),
          errors: (Array.isArray(s.errors) ? s.errors : []).slice(0, 3).map(e => ({
            code: Number.isSafeInteger(e?.code) ? e.code : undefined,
            title: clip(e?.title), message: clip(e?.message), details: clip(e?.error_data?.details),
          })),
        });
      }
    }
  }
  return events;
}
export class DeliveryStore {
  constructor(file, now = () => Date.now()) {
    if (!isAbsolute(file || "")) throw new Error("Delivery store requires an absolute file path");
    this.file = file; this.now = now; this.tail = Promise.resolve();
  }
  serial(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async load() {
    try {
      if ((await fs.stat(this.file)).size > MAX_FILE) throw new Error("Delivery store exceeds size limit");
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(data)) throw new Error("Invalid delivery store");
      return data.filter(r => Number.isFinite(r.received_at) && r.received_at > this.now() - TTL);
    } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
  async save(rows) {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(rows)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, this.file);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  ingest(events) {
    return this.serial(async () => {
      const records = new Map((await this.load()).map(r => [`${r.waba_id}:${r.id}`, r]));
      for (const event of events) {
        const key = `${event.waba_id}:${event.id}`;
        const row = records.get(key) || { id: event.id, waba_id: event.waba_id, history: [] };
        const normalized = JSON.parse(JSON.stringify(event));
        if (row.history.some(e => JSON.stringify(e) === JSON.stringify(normalized))) continue;
        row.history.push(normalized);
        row.history.sort((a, b) => a.timestamp - b.timestamp || ORDER[a.status] - ORDER[b.status]);
        row.history = row.history.slice(-10);
        row.latest = row.history.at(-1); row.received_at = this.now(); records.set(key, row);
      }
      await this.save([...records.values()].sort((a, b) => a.received_at - b.received_at).slice(-1000));
    });
  }
  get(id, wabaId) {
    return this.serial(async () => (await this.load()).find(r => r.id === id && r.waba_id === wabaId) || null);
  }
}
let singleton;
function storeFor(env) {
  if (!singleton || singleton.file !== env.WHATSAPP_STATUS_FILE) singleton = new DeliveryStore(env.WHATSAPP_STATUS_FILE);
  return singleton;
}
export async function getDeliveryStatus(messageId, env = process.env) {
  if (!deliveryConfig(env)) return { status: "not_configured", source: "webhook", message: "Configure webhook secrets, WABA, persistent storage and MCP bearer authentication first." };
  const row = await storeFor(env).get(messageId, env.WHATSAPP_WABA_ID);
  if (!row) return { id: messageId, status: "unknown", source: "webhook", message: "No retained webhook receipt for this message. This is not proof of delivery or failure; older sends are not backfilled." };
  return { ...row.latest, source: "webhook", received_at: row.received_at, history: row.history };
}
function reply(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => finish(Object.assign(new Error("Body timeout"), { status: 408 })), 15000);
    function finish(error) {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", aborted);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks));
    }
    function data(chunk) {
      size += chunk.length;
      if (size > MAX_BODY) return finish(Object.assign(new Error("Body too large"), { status: 413 }));
      chunks.push(chunk);
    }
    function end() { finish(); }
    function fail() { finish(Object.assign(new Error("Body failed"), { status: 400 })); }
    function aborted() { fail(); }
    req.on("data", data); req.on("end", end); req.on("error", fail); req.on("aborted", aborted);
  });
}
export async function handleDeliveryWebhook(req, res, url, env = process.env, store) {
  if (!deliveryConfig(env)) return reply(res, 503, "Delivery webhooks not configured");
  if (req.method === "GET") {
    const q = url.searchParams, challenge = q.get("hub.challenge");
    if (q.get("hub.mode") !== "subscribe" || !safeEqual(q.get("hub.verify_token"), env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) ||
        !challenge || challenge.length > 1024) return reply(res, 403, "Verification denied");
    return reply(res, 200, challenge);
  }
  if (req.method !== "POST") return reply(res, 405, "Method not allowed");
  const signature = req.headers["x-hub-signature-256"];
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(signature)) { req.resume(); return reply(res, 401, "Invalid signature"); }
  let raw;
  try { raw = await readBody(req); } catch (e) { return reply(res, e.status || 400, "Invalid request body"); }
  if (!validSignature(raw, signature, env.WHATSAPP_APP_SECRET)) return reply(res, 401, "Invalid signature");
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return reply(res, 400, "Invalid JSON"); }
  try {
    const events = extractStatuses(payload, env.WHATSAPP_WABA_ID);
    if (events.length) await (store || storeFor(env)).ingest(events);
    return reply(res, 200, "EVENT_RECEIVED");
  } catch {
    // No success acknowledgement on failed persistence. No private payload logging.
    return reply(res, 503, "Delivery storage unavailable; retry");
  }
}
