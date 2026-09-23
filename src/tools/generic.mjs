import { z } from "zod";
import { callApi, errorResponse, jsonResponse, parseJsonParam } from "../api.mjs";
import { uploadTemplateImage } from "../template-upload.mjs";

// Existing Graph resource allowlist is unchanged. Image uploads use a separate,
// exact, POST-only local adapter, not a broader Graph proxy.
const ALLOWED_PATTERNS = [
  /^\/\d+\/message_templates(\/|$|\?)/,
  /^\/\d+\/phone_numbers(\/|$|\?)/,
  /^\/\d+\/subscribed_apps(\/|$|\?)/,
  /^\/\d+\/owned_whatsapp_business_accounts(\/|$|\?)/,
  /^\/\d+\/conversation_analytics(\/|$|\?)/,
  /^\/\d+\/template_analytics(\/|$|\?)/,
  /^\/\d+\/messages(\/|$|\?)/,
  /^\/\d+\/whatsapp_business_profile(\/|$|\?)/,
  /^\/\d+\/media(\/|$|\?)/,
  /^\/\d+(\?|$)/,
  /^\/wamid\.[A-Za-z0-9_-]+(\?|$)/,
];

const DENIED_HINT =
  "Path not on the allowlist. wa_api_call is restricted to WhatsApp Business endpoints. Use a dedicated tool when one exists.";

function isAllowed(path) {
  return ALLOWED_PATTERNS.some((re) => re.test(path));
}

function validationError(message) {
  return { isError: true, content: [{ type: "text", text: `Validation error: ${message}` }] };
}

export function registerGenericTools(server) {
  server.tool(
    "wa_upload_template_image",
    "Upload a PNG/JPEG sample via Meta Resumable Upload and return a real header_handle for an IMAGE template. Does not create a template or send messages. Provide either a direct HTTPS attachments.clickup.com file_url or canonical file_base64, at most 5 MiB. app_id is optional: uses WHATSAPP_APP_ID or identifies the token's app. Credentials stay server-side.",
    {
      file_url: z.string().optional().describe("Direct HTTPS ClickUp attachment URL; redirects are rejected"),
      file_base64: z.string().optional().describe("Base64 image bytes, without a data URL prefix; alternative to file_url"),
      file_name: z.string().optional().describe("Simple filename, e.g. session-reminder.png"),
      app_id: z.string().regex(/^\d+$/).optional().describe("Meta app ID, not WABA or phone number ID"),
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    async (input) => {
      const data = await uploadTemplateImage(input);
      return data.error ? errorResponse(data) : jsonResponse(data);
    }
  );

  server.tool(
    "wa_api_call",
    [
      "Escape hatch for allowlisted WhatsApp Business / Meta Graph endpoints.",
      "Allowed resources: message_templates, phone_numbers, messages, media, business_profile, analytics, subscribed_apps, owned_whatsapp_business_accounts, single-ID reads, wamid lookups.",
      "Prefer typed tools when available.",
      "Compatibility upload adapter: POST /template_header_upload with body_json containing exactly one of file_url or file_base64, plus optional file_name and app_id. No query_params. Equivalent to wa_upload_template_image, not a Graph resource. Returns header_handle; never sends messages.",
      "For other paths, query_params is a raw query string and body_json is a JSON request body.",
    ].join("\n"),
    {
      method: z.enum(["GET", "POST", "DELETE"]).describe("HTTP method"),
      path: z.string().startsWith("/", "path must start with /").describe("Allowlisted Graph path or /template_header_upload"),
      query_params: z.string().optional().describe("Query string without leading ?"),
      body_json: z.string().optional().describe("JSON string of request body"),
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    async ({ method, path, query_params, body_json }) => {
      if (path === "/template_header_upload") {
        if (method !== "POST" || query_params) return validationError("Image upload requires POST with no query_params.");
        let input;
        try { input = JSON.parse(body_json || "null"); }
        catch { return validationError("body_json must be valid JSON."); }
        const data = await uploadTemplateImage(input);
        return data.error ? errorResponse(data) : jsonResponse(data);
      }
      if (!isAllowed(path)) {
        return { isError: true, content: [{ type: "text", text: `Error [path_not_allowed]: ${path}\n${DENIED_HINT}` }] };
      }
      let body = null;
      try {
        body = body_json ? parseJsonParam(body_json, "body_json") : null;
      } catch (e) {
        return validationError(e.message);
      }
      const fullPath = query_params ? `${path}?${query_params}` : path;
      const data = await callApi(method, fullPath, body);
      return data.error ? errorResponse(data) : jsonResponse(data);
    }
  );
}

export const _internal = { ALLOWED_PATTERNS, isAllowed };
