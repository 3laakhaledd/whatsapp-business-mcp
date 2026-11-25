/*
 * Polls Meta every minute for the review status and category of each template recorded in
 * SPEN's ClickUp "WA Business Templates" list, and mirrors changes into the list's
 * "Meta Status" and "Meta Category" fields (with one comment per change).
 *
 * This complements the webhook in template-status-sync.mjs: it also catches changes that
 * happened while the webhook was not subscribed or the service was down.
 *
 * Railway (HTTP mode only):
 *   CLICKUP_API_TOKEN               required (same token as the webhook sync)
 *   WHATSAPP_TOKEN                  required (Meta token with whatsapp_business_management)
 *   CLICKUP_TEMPLATES_LIST_ID       optional, defaults to 901821740548
 *   TEMPLATE_STATUS_POLL            optional, set to "off" to disable
 *   TEMPLATE_STATUS_POLL_INTERVAL_MS optional, defaults to 60000 (minimum 30000)
 *
 * Read-only towards Meta: it only GETs template objects. It never creates, edits, deletes or
 * sends anything on WhatsApp, and never changes the ClickUp task status itself.
 */
import { templateSyncConfig, STATUS_LABELS, CATEGORY_LABELS, optionFor, sameOption } from "./template-status-sync.mjs";

const API = "https://api.clickup.com/api/v2";
const DEFAULT_INTERVAL = 60_000;
const MIN_INTERVAL = 30_000;
// Final states: a deleted template cannot change again, so it is not polled.
const SKIP_LABELS = new Set(["Deleted"]);

export function pollConfig(env = process.env) {
  if (String(env.TEMPLATE_STATUS_POLL || "").toLowerCase() === "off") return null;
  const sync = templateSyncConfig(env);
  if (!sync || typeof env.WHATSAPP_TOKEN !== "string" || !env.WHATSAPP_TOKEN) return null;
  const requested = Number(env.TEMPLATE_STATUS_POLL_INTERVAL_MS || DEFAULT_INTERVAL);
  const intervalMs = Number.isFinite(requested) ? Math.max(MIN_INTERVAL, requested) : DEFAULT_INTERVAL;
  return { ...sync, intervalMs };
}

function riyadhNow(now) {
  return new Date(now()).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) + " (Asia/Riyadh)";
}

export function pollComment(name, changes, when) {
  const parts = changes.map(c => `${c.label} ${c.from ? `changed from ${c.from} to` : "set to"} ${c.to}`);
  return `Meta check: ${name}: ${parts.join("; ")}. Checked ${when}. Logged automatically by the one-minute template check; no messages were sent.`;
}

export async function pollTemplatesOnce(env = process.env, deps = {}) {
  const cfg = pollConfig(env);
  if (!cfg) return { skipped: "not_configured", checked: 0, updated: 0, errors: 0 };
  const fetchFn = deps.fetch || globalThis.fetch;
  const graph = deps.graph || (await import("./api.mjs")).callApi;
  const now = deps.now || (() => Date.now());

  async function clickup(path, options = {}) {
    const res = await fetchFn(`${API}${path}`, {
      ...options,
      headers: { Authorization: cfg.token, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`ClickUp request failed (HTTP ${res.status}).`);
    return res.status === 204 ? {} : res.json();
  }

  const { fields = [] } = await clickup(`/list/${cfg.listId}/field`);
  const byName = name => fields.find(f => f.name === name);
  const idField = byName("Meta Template ID");
  const statusField = byName("Meta Status");
  const categoryField = byName("Meta Category");
  if (!idField) return { skipped: "missing_template_id_field", checked: 0, updated: 0, errors: 0 };

  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const data = await clickup(`/list/${cfg.listId}/task?include_closed=true&subtasks=true&page=${page}`);
    tasks.push(...(data.tasks || []));
    if (data.last_page !== false || !(data.tasks || []).length) break;
  }
  const valueOf = (task, field) => field && (task.custom_fields || []).find(f => f.id === field.id)?.value;
  const labelOf = (field, value) => (field?.type_config?.options || [])
    .find(o => value !== undefined && value !== null && (String(o.id) === String(value) || String(o.orderindex) === String(value)))?.name;

  let checked = 0, updated = 0, errors = 0;
  const cache = new Map();
  for (const task of tasks) {
    const templateId = String(valueOf(task, idField) ?? "").trim();
    if (!/^\d{1,32}$/.test(templateId)) continue;
    const currentStatus = valueOf(task, statusField);
    if (SKIP_LABELS.has(labelOf(statusField, currentStatus))) continue;

    if (!cache.has(templateId)) {
      cache.set(templateId, await graph("GET", `/${templateId}?fields=id,name,status,category`));
    }
    const meta = cache.get(templateId);
    checked++;
    if (!meta || meta.error) { errors++; continue; }

    const changes = [];
    const statusOption = optionFor(statusField, STATUS_LABELS[String(meta.status || "").toUpperCase()]);
    if (statusField && statusOption && !sameOption(currentStatus, statusOption)) {
      changes.push({ field: statusField, option: statusOption, label: "Meta Status", from: labelOf(statusField, currentStatus), to: statusOption.name });
    }
    const currentCategory = valueOf(task, categoryField);
    const categoryOption = optionFor(categoryField, CATEGORY_LABELS[String(meta.category || "").toUpperCase()]);
    if (categoryField && categoryOption && !sameOption(currentCategory, categoryOption)) {
      changes.push({ field: categoryField, option: categoryOption, label: "Meta Category", from: labelOf(categoryField, currentCategory), to: categoryOption.name });
    }
    if (!changes.length) continue;

    // Comment first: if it fails, the fields stay unchanged and the next run retries both.
    await clickup(`/task/${task.id}/comment`, {
      method: "POST",
      body: JSON.stringify({ comment_text: pollComment(meta.name || `template ${templateId}`, changes, riyadhNow(now)), notify_all: false }),
    });
    for (const change of changes) {
      await clickup(`/task/${task.id}/field/${change.field.id}`, { method: "POST", body: JSON.stringify({ value: change.option.id }) });
    }
    updated++;
  }
  return { checked, updated, errors };
}

export function startTemplateStatusPoller(env = process.env, deps = {}) {
  const cfg = pollConfig(env);
  if (!cfg) return null;
  const log = deps.log || console.error;
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const result = await pollTemplatesOnce(env, deps);
      if (result.updated || result.errors) log(`Template status check: ${result.checked} checked, ${result.updated} updated, ${result.errors} Meta errors.`);
    } catch (e) {
      log("Template status check failed:", e?.message || "unknown error");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, deps.firstDelayMs ?? 5000);
  const timer = setInterval(tick, cfg.intervalMs);
  first.unref?.();
  timer.unref?.();
  return { intervalMs: cfg.intervalMs, tick, stop() { clearTimeout(first); clearInterval(timer); } };
}
