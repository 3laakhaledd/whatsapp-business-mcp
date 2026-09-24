import { promises as fs } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, dirname } from 'node:path';

// Single Railway replica, persistent volume required. Deploying never sends.
// No automatic retry of any attempted recipient, even after a process crash.
// A stale lock after a crash requires operator review/removal, not auto-expiry.
// Private ledgers contain phone numbers: keep volume access restricted.
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[٠-٩]/g, c => String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0)-1776));
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  s = s.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^01[0125]\d{8}$/.test(s)) s = '+20' + s.slice(1);
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^[1-9]\d{6,14}$/.test(s)) return null;
  if (s.startsWith('20') && !/^201[0125]\d{8}$/.test(s)) return null;
  // Non-mobile Egyptian entries are held for review, not declared unregistered.
  return s;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const counts = rows => rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class BulkDelivery {
  constructor(directory, send, receipt = async () => ({ status: 'unknown' }), pause = ms => new Promise(r => setTimeout(r, ms))) {
    if (!isAbsolute(directory || '')) throw new Error('Persistent absolute batch directory required');
    this.directory = directory; this.send = send; this.receipt = receipt; this.pause = pause;
  }
  path(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid batch ID');
    return join(this.directory, id + '.json');
  }
  async lock(id, fn) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id) + '.lock';
    let h;
    try { h = await fs.open(path, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Batch busy or interrupted: inspect lock before resuming; do not resend manually'); throw e; }
    try { return await fn(); }
    finally { await h.close(); await fs.unlink(path); }
  }
  async save(id, data) {
    const file = this.path(id), temp = file + '.' + randomUUID() + '.tmp';
    try {
      const h = await fs.open(temp, 'wx', 0o600);
      try { await h.writeFile(JSON.stringify(data)); await h.sync(); } finally { await h.close(); }
      await fs.rename(temp, file);
      const dir = await fs.open(dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async load(id) {
    const file = this.path(id);
    if ((await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('Batch file too large');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  preview(b) {
    return { batch_id: b.id, confirm_token: b.confirm_token, source: b.source, expected_records: b.expected_records,
      unique_recipients: b.rows.length, skipped_records: b.skipped.length, counts: counts(b.rows),
      template_name: b.template_name, phone_number_id: b.phone_number_id,
      samples: b.rows.slice(0, 5).map(r => ({ to: r.to, source_index: r.source_index })), messages_sent_by_prepare: 0 };
  }
  async prepare(input) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.campaign_key || '')) throw new Error('Invalid campaign key');
    if (!/^\d+$/.test(input.phone_number_id || '') || !/^[a-z0-9_]{1,512}$/.test(input.template_name || '') || !/^[a-z]{2}(_[A-Z]{2})?$/.test(input.language_code || '')) throw new Error('Invalid sender or template');
    if (typeof input.source !== 'string' || input.source.length < 1 || input.source.length > 1000) throw new Error('Source snapshot description required');
    if (!Array.isArray(input.recipients) || input.recipients.length < 1 || input.recipients.length > 1000 || input.recipients.length !== input.expected_records) throw new Error('Recipient count must equal the approved expected_records (1..1000)');
    if (!Array.isArray(input.components) || JSON.stringify(input.components).length > 20000) throw new Error('Invalid template components');
    const fingerprint = hash(input), id = hash(input.campaign_key);
    return this.lock(id, async () => {
      let existing;
      try { existing = await this.load(id); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('Campaign key already exists with different inputs; review existing batch before any new campaign');
        return this.preview(existing);
      }
      const seen = new Set(), rows = [], skipped = [];
      input.recipients.forEach((raw, i) => {
        const to = normalizePhone(raw);
        if (!to) { skipped.push({ source_index: i, raw, reason: 'invalid_or_ambiguous_requires_review' }); return; }
        if (seen.has(to)) { skipped.push({ source_index: i, raw, to, reason: 'duplicate' }); return; }
        seen.add(to); rows.push({ source_index: i, to, state: 'pending' });
      });
      if (!rows.length) throw new Error('No valid recipients');
      const b = { ...input, recipients: undefined, id, fingerprint, confirm_token: randomBytes(32).toString('hex'), rows, skipped, created_at: new Date().toISOString() };
      await this.save(id, b);
      return this.preview(b);
    });
  }
  async run(id, token, limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Run limit must be 1..10');
    return this.lock(id, async () => {
      const b = await this.load(id);
      if (!same(token, b.confirm_token)) throw new Error('Confirmation token mismatch');
      const uncertain = b.rows.filter(r => r.state === 'attempting');
      for (const r of uncertain) { r.state = 'uncertain'; r.reason = 'Interrupted after durable intent: never auto-retry'; }
      if (uncertain.length) await this.save(id, b);
      if (b.rows.some(r => r.state === 'uncertain' || r.state === 'failed')) return { batch_id: id, halted: true, counts: counts(b.rows), message: 'Review failed/uncertain sends before continuing. No automatic retries.' };
      const start = Date.now(); let attempted = 0;
      for (const r of b.rows.filter(r => r.state === 'pending').slice(0, limit)) {
        if (Date.now() - start > 20000) break;
        r.state = 'attempting'; r.attempted_at = new Date().toISOString();
        await this.save(id, b); // Write intent BEFORE contacting Meta.
        attempted++;
        try {
          const result = await this.send({ messaging_product: 'whatsapp', to: '+' + r.to, type: 'template',
            template: { name: b.template_name, language: { code: b.language_code }, components: b.components } }, b.phone_number_id);
          if (result.error) {
            const e = result.error;
            r.state = e.http_status >= 400 && e.http_status < 500 ? 'failed' : 'uncertain';
            r.error = { code: e.code, http_status: e.http_status, message: String(e.message || 'Unknown Meta error').slice(0, 1000) };
          } else if (typeof result.messages?.[0]?.id === 'string' && result.messages[0].id.startsWith('wamid.')) {
            r.state = 'accepted'; r.message_id = result.messages[0].id;
          } else { r.state = 'uncertain'; r.reason = 'No message ID in response'; }
        } catch { r.state = 'uncertain'; r.reason = 'Network or timeout: Meta acceptance unknown; never auto-retry'; }
        await this.save(id, b);
        if (r.state !== 'accepted') break;
        await this.pause(250);
      }
      return { batch_id: id, attempted_this_call: attempted, counts: counts(b.rows), skipped_records: b.skipped.length,
        halted: b.rows.some(r => ['failed', 'uncertain'].includes(r.state)),
        message: 'Accepted is not delivered. Re-run same batch/token for remaining pending recipients only; report for webhook receipts.' };
    });
  }
  async report(id, offset = 0, limit = 100) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid report page');
    const b = await this.load(id), delivery = {}, rows = [];
    for (const r of b.rows) {
      let receipt;
      if (r.message_id) {
        try { receipt = await this.receipt(r.message_id); } catch { receipt = { status: 'lookup_unavailable' }; }
        const status = receipt?.status || 'unknown'; delivery[status] = (delivery[status] || 0) + 1;
      }
      rows.push({ ...r, receipt });
    }
    return { batch_id: id, source: b.source, total_source_records: b.expected_records, unique_recipients: b.rows.length,
      submission_counts: counts(b.rows), delivery_counts: delivery, skipped_records: b.skipped.length,
      rows: rows.slice(offset, offset + limit), skipped: b.skipped.slice(offset, offset + limit),
      next_offset: offset + limit < Math.max(rows.length, b.skipped.length) ? offset + limit : null,
      note: 'Accepted/submission and webhook delivery are separate totals. Unknown is not success or failure.' };
  }
}
