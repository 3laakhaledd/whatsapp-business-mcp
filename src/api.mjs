const API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

export function getToken() {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("WHATSAPP_TOKEN env var not set");
  return token;
}

export function getPageToken() {
  const token = process.env.META_PAGE_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN (or WHATSAPP_TOKEN) env var not set");
  return token;
}

// E.164: + optional, 1-15 digits, country code starts with non-zero.
const E164_RE = /^\+?[1-9]\d{6,14}$/;
export function validatePhoneE164(value, field = "phone") {
  if (typeof value !== "string" || !E164_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: "${value}". Must be E.164 format (digits only, country code first, no spaces or punctuation), e.g. 351912345678.`
    );
  }
  return value.startsWith("+") ? value.slice(1) : value;
}

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
export function validateTemplateName(name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid template name: "${name}". Must be lowercase letters, digits and underscores only.`
    );
  }
  return name;
}

const LANG_RE = /^[a-z]{2}(_[A-Z]{2})?$/;
export function validateLanguageCode(code) {
  if (typeof code !== "string" || !LANG_RE.test(code)) {
    throw new Error(
      `Invalid language_code: "${code}". Expected e.g. "en", "pt_PT", "es".`
    );
  }
  return code;
}

function classifyHttpError(status, errBody) {
  const code = errBody?.code;
  const subcode = errBody?.error_subcode;
  if (status === 401 || code === 190) {
    if (subcode === 463) return { kind: "token_expired", hint: "The access token has expired. Issue a new one in Meta Business." };
    if (subcode === 467) return { kind: "token_invalid", hint: "The access token is invalid or revoked." };
    return { kind: "auth", hint: "Authentication failed. Check WHATSAPP_TOKEN." };
  }
  if (status === 403 || code === 10 || code === 200) {
    return { kind: "permission_denied", hint: "Token lacks permission for this resource. Verify scopes (whatsapp_business_management, whatsapp_business_messaging) and that the app/user has access to this WABA/Business." };
  }
  if (status === 429 || code === 4 || code === 80007 || code === 80008) {
    return { kind: "rate_limited", hint: "Rate limit hit on Graph API. Back off and retry later." };
  }
  if (status === 404) return { kind: "not_found", hint: "Resource not found. Check the ID." };
  if (status >= 500) return { kind: "upstream_error", hint: "Meta Graph API server error. Try again." };
  return { kind: "api_error", hint: null };
}

async function _callWithToken(token, method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    return { error: { message: `Network error calling Graph API: ${e.message}`, kind: "network_error" } };
  }
  const text = await res.text();
  const cleaned = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
    ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
  );

  let data;
  try {
    data = cleaned ? JSON.parse(cleaned) : {};
  } catch {
    return {
      error: {
        message: `Invalid JSON from Graph API (HTTP ${res.status})`,
        kind: "upstream_error",
        http_status: res.status,
        raw: cleaned.slice(0, 500),
      },
    };
  }

  if (!res.ok || data.error) {
    const errBody = data.error || {};
    const classified = classifyHttpError(res.status, errBody);
    return {
      error: {
        ...errBody,
        kind: classified.kind,
        hint: classified.hint,
        http_status: res.status,
      },
    };
  }

  return data;
}

export async function callApi(method, path, body = null) {
  return _callWithToken(getToken(), method, path, body);
}

export async function callPageApi(method, path, body = null) {
  return _callWithToken(getPageToken(), method, path, body);
}

export function errorResponse(data) {
  const err = data.error || {};
  const base = err.error_user_msg || err.message || "Unknown error";
  const parts = [`Error [${err.kind || "api_error"}]: ${base}`];
  if (err.http_status) parts.push(`(HTTP ${err.http_status})`);
  if (err.hint) parts.push(`\nHint: ${err.hint}`);
  return { isError: true, content: [{ type: "text", text: parts.join(" ") }] };
}

export function parseJsonParam(str, paramName) {
  try {
    return JSON.parse(str);
  } catch {
    throw new Error(`Invalid JSON in ${paramName}: ${str}`);
  }
}

export function textResponse(text) {
  return { content: [{ type: "text", text }] };
}

export function jsonResponse(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
