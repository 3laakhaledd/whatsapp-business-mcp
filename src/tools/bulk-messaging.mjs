import { z } from 'zod';
import { dirname } from 'node:path';
import { BulkDelivery } from '../bulk-delivery.mjs';
import { deliveryConfig, getDeliveryStatus } from '../delivery-webhooks.mjs';
function engine() {
  if (!deliveryConfig() || !process.env.WHATSAPP_TOKEN) throw new Error('Configure authenticated webhooks, Meta token and persistent storage first');
  return new BulkDelivery(dirname(process.env.WHATSAPP_STATUS_FILE) + '/batches', async (body, sender) => {
    const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
    if (!/^v\d+\.\d+$/.test(version)) throw new Error('Invalid API version');
    const r = await fetch(`https://graph.facebook.com/${version}/${sender}/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await r.json();
    if (!r.ok || value.error) return { error: { ...value.error, http_status: r.status } };
    return value;
  }, getDeliveryStatus);
}
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const safe = fn => async args => {
  try { return text(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.code ? 'Batch storage unavailable: no automatic retries. Check persistent volume and lock.' : e.message }] }; }
};
export function registerBulkMessagingTools(server) {
  server.tool('wa_prepare_template_batch',
    'Prepare an immutable, deduplicated recipient snapshot on persistent storage. NEVER sends. Supply every approved source record including duplicates; expected_records must match. Reusing campaign_key with different inputs is refused. Returns preview and confirm_token. Keep the same key for retries; never create a new key to retry a send.',
    { campaign_key: z.string().min(8).max(100), source: z.string().min(1).max(1000), expected_records: z.number().int().min(1).max(1000),
      phone_number_id: z.string().regex(/^\d+$/), template_name: z.string(), language_code: z.string(),
      recipients: z.array(z.string().max(100)).min(1).max(1000), components_json: z.string().max(20000) },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    safe(async ({ components_json, ...rest }) => engine().prepare({ ...rest, components: JSON.parse(components_json) })));
  server.tool('wa_run_template_batch',
    'SEND up to 10 pending recipients from a prepared batch. Requires explicit user approval of audience/message and the preview confirm_token. Durable intent prevents automatic resend after ambiguous failures. Same batch/token resumes pending only. Stops on first failure/uncertainty. No startup or background sending. Single persistent-volume replica only.',
    { batch_id: z.string().regex(/^[a-f0-9]{64}$/), confirm_token: z.string().regex(/^[a-f0-9]{64}$/), limit: z.number().int().min(1).max(10).default(5) },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    safe(({ batch_id, confirm_token, limit }) => engine().run(batch_id, confirm_token, limit)));
  server.tool('wa_get_template_batch_report',
    'Read a persisted batch ledger and verified delivery webhook receipts. Separates pending, accepted, failed, uncertain, duplicates and invalid/ambiguous entries; acceptance is not delivery. Page rows and skips using next_offset. Does not send.',
    { batch_id: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(100) },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    safe(({ batch_id, offset, limit }) => engine().report(batch_id, offset, limit)));
}
