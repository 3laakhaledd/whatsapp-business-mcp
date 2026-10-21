/*
 * Mirrors Meta template review events into SPEN's ClickUp "WA Business Templates" list.
 *
 * Meta: in the app's WhatsApp webhook configuration, subscribe whatsapp_business_account to
 *   message_template_status_update and template_category_update (next to messages).
 * Railway: set CLICKUP_API_TOKEN (a ClickUp personal token, pk_...). Optional:
 *   CLICKUP_TEMPLATES_LIST_ID (defaults to 901821740548).
 * ClickUp: the list needs fields "Meta Template ID" (text), "Meta Status" (dropdown) and
 *   "Meta Category" (dropdown). Tasks are matched by Meta Template ID.
 *
 * Never sends WhatsApp messages. Without CLICKUP_API_TOKEN, events are ignored.
 */
const API = "https://api.clickup.com/api/v2";
const DEFAULT_LIST = "901821740548";

export const STATUS_LABELS = {
  APPROVED: "Approved", REINSTATED: "Approved",
  PENDING: "Pending",
  REJECTED: "Rejected",
  PAUSED: "Paused",
  FLAGGED: "Flagged", LIMIT_EXCEEDED: "Flagged",
  DISABLED: "Disabled", ARCHIVED: "Disabled",
  IN_APPEAL: "In Appeal",
  PENDING_DELETION: "Deleted", DELETED: "Deleted",
};
export const CATEGORY_LABELS = { UTILITY: "Utility", MARKETING: "Marketing", AUTHENTICATION: "Authentication" };

const clip = v => typeof v === "string" && v.length ? v.slice(0, 200) : undefined;
const upper = v => clip(v)?.toUpperCase();

export function templateSyncConfig(env = process.env) {
  const token = env.CLICKUP_API_TOKEN;
  const listId = env.CLICKUP_TEMPLATES_LIST_ID || DEFAULT_LIST;
  if (typeof token !== "string" || token.length < 10 || !/^\d+$/.test(listId)) return null;
  return { token, listId };
}

export function extractTemplateEvents(payload, wabaId) {
  const events = [];
  if (payload?.object !== "whatsapp_business_account") return events;
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    if (entry?.id !== wabaId) continue;
    const time = Number.isSafeInteger(entry.time) ? entry.time : undefined;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      const templateId = String(value?.message_template_id ?? "");
      if (!/^\d{1,32}$/.test(templateId)) continue;
      const base = {
        template_id: templateId,
        name: clip(value.message_template_name),
        language: clip(value.message_template_language),
        time,
      };
      if (change.field === "message_template_status_update" && upper(value.event)) {
        events.push({ ...base, kind: "status", event: upper(value.event),
          reason: clip(value.reason), detail: clip(value.other_info?.description || value.other_info?.title) });
      } else if (change.field === "template_category_update") {
        const category = upper(value.new_category || value.correct_category);
        if (category) events.push({ ...base, kind: "category", category, previous: upper(value.previous_category) });
      }
    }
  }
  return events;
}

function riyadhTime(seconds) {
  const date = seconds ? new Date(seconds * 1000) : new Date();
  return date.toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) + " (Asia/Riyadh)";
}

export function commentFor(ev) {
  const name = ev.name || `template ${ev.template_id}`;
  const when = riyadhTime(ev.time);
  if (ev.kind === "category") {
    const from = ev.previous ? ` from ${ev.previous}` : "";
    return `Meta update: ${name} was re-categorized${from} to ${ev.category}. Received ${when}. Logged automatically by the WhatsApp webhook; no messages were sent.`;
  }
  const reason = ev.reason && ev.reason !== "NONE" ? ` Reason: ${ev.reason}.` : "";
  const detail = ev.detail ? ` ${ev.detail}` : "";
  return `Meta update: ${name} is now ${ev.event}.${reason}${detail} Received ${when}. Logged automatically by the WhatsApp webhook; no messages were sent.`;
}

function optionFor(field, label) {
  return (field?.type_config?.options || []).find(o => o.name === label) || null;
}

function sameOption(current, option) {
  if (current === undefined || current === null || !option) return false;
  return String(current) === String(option.id) || String(current) === String(option.orderindex);
}

export async function syncTemplateEvents(events, env = process.env, deps = {}) {
  const cfg = templateSyncConfig(env);
  if (!cfg) return { skipped: "not_configured", updated: 0 };
  if (!events.length) return { updated: 0 };
  const fetchFn = deps.fetch || globalThis.fetch;

  async function clickup(path, options = {}) {
    const res = await fetchFn(`${API}${path}`, {
      ...options,
      headers: { Authorization: cfg.token, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const error = new Error(`ClickUp request failed (HTTP ${res.status}).`);
      error.retryable = res.status === 429 || res.status >= 500;
      throw error;
    }
    return res.status === 204 ? {} : res.json();
  }

  const { fields = [] } = await clickup(`/list/${cfg.listId}/field`);
  const byName = name => fields.find(f => f.name === name);
  const idField = byName("Meta Template ID");
  const statusField = byName("Meta Status");
  const categoryField = byName("Meta Category");
  if (!idField) return { skipped: "missing_template_id_field", updated: 0 };

  // The templates list is small; read it once and match on the Meta Template ID field.
  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const data = await clickup(`/list/${cfg.listId}/task?include_closed=true&subtasks=true&page=${page}`);
    tasks.push(...(data.tasks || []));
    if (data.last_page !== false || !(data.tasks || []).length) break;
  }
  const fieldValue = (task, field) => field && (task.custom_fields || []).find(f => f.id === field.id)?.value;

  let updated = 0;
  const unmatched = [];
  for (const ev of events) {
    const matches = tasks.filter(t => String(fieldValue(t, idField) ?? "").trim() === ev.template_id);
    if (!matches.length) { unmatched.push(ev.template_id); continue; }
    const target = ev.kind === "status"
      ? { field: statusField, option: optionFor(statusField, STATUS_LABELS[ev.event]) }
      : { field: categoryField, option: optionFor(categoryField, CATEGORY_LABELS[ev.category]) };
    for (const task of matches) {
      // Meta retries deliveries; skip the comment when the field already shows this value.
      if (target.option && sameOption(fieldValue(task, target.field), target.option)) continue;
      if (target.field && target.option) {
        await clickup(`/task/${task.id}/field/${target.field.id}`, {
          method: "POST", body: JSON.stringify({ value: target.option.id }),
        });
      }
      await clickup(`/task/${task.id}/comment`, {
        method: "POST", body: JSON.stringify({ comment_text: commentFor(ev), notify_all: true }),
      });
      updated++;
    }
  }
  return { updated, unmatched };
}
