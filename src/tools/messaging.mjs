import { z } from "zod";
import {
  callApi,
  errorResponse,
  textResponse,
  jsonResponse,
  parseJsonParam,
  validatePhoneE164,
  validateTemplateName,
  validateLanguageCode,
} from "../api.mjs";
import { getDeliveryStatus } from "../delivery-webhooks.mjs";

export function registerMessagingTools(server) {
  server.tool(
    "wa_send_template",
    [
      "Send a pre-approved template message to a recipient on WhatsApp.",
      "",
      "When to use: outbound notifications, marketing or utility messages where the recipient is",
      "outside the 24-hour customer service window, or any first-contact message.",
      "",
      "Requirements:",
      "- The template must already exist and be in APPROVED status (use wa_get_templates to verify).",
      "- `phone_number_id` is the numeric ID of YOUR sending number (from wa_get_phone_numbers),",
      "  NOT the destination phone.",
      "- `to` must be E.164 (digits only, country code first), e.g. 351912345678.",
      "- `components_json` is required when the template has variables ({{1}}, header media, buttons).",
      "",
      "Returns: the accepted WhatsApp message ID (wamid); acceptance is not delivery.",
      "Use wa_get_message_status to read retained webhook receipts after callbacks arrive.",
      "Header media must be supplied at send time. Never infer delivery from acceptance.",
    ].join("\n"),
    {
      phone_number_id: z
        .string()
        .regex(/^\d+$/, "phone_number_id must be the numeric ID, not a phone number")
        .describe("Numeric ID of the sending WhatsApp phone number (from wa_get_phone_numbers)"),
      to: z
        .string()
        .describe("Recipient phone number in E.164 format (digits, country code first), e.g. 351912345678"),
      template_name: z
        .string()
        .describe("Approved template name (lowercase, digits, underscores only)"),
      language_code: z
        .string()
        .describe("Language/locale code of the template, e.g. en, pt_PT, es_ES"),
      components_json: z
        .string()
        .optional()
        .describe(
          'JSON array of components with parameter values, e.g. [{"type":"body","parameters":[{"type":"text","text":"Alice"}]}]'
        ),
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    async ({ phone_number_id, to, template_name, language_code, components_json }) => {
      let normalizedTo, normalizedName, normalizedLang, components;
      try {
        normalizedTo = validatePhoneE164(to, "to");
        normalizedName = validateTemplateName(template_name);
        normalizedLang = validateLanguageCode(language_code);
        components = components_json ? parseJsonParam(components_json, "components_json") : null;
        if (components && !Array.isArray(components)) {
          throw new Error("components_json must be a JSON array");
        }
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Validation error: ${e.message}` }] };
      }

      const payload = {
        messaging_product: "whatsapp",
        to: normalizedTo,
        type: "template",
        template: {
          name: normalizedName,
          language: { code: normalizedLang },
        },
      };
      if (components) payload.template.components = components;

      const data = await callApi("POST", `/${phone_number_id}/messages`, payload);
      if (data.error) return errorResponse(data);

      const msgId = data.messages?.[0]?.id || "unknown";
      return textResponse(`Message accepted. wamid: ${msgId}`);
    }
  );

  server.tool(
    "wa_get_message_status",
    [
      "Read verified WhatsApp delivery webhook receipts saved by this server for a message ID.",
      "Returns latest status, timestamp, failure codes/details and retained event history.",
      "Unknown means no retained receipt, NOT delivered or failed. No Graph API polling is used.",
      "Requires configured webhook secrets, persistent storage, WABA scope and MCP bearer auth.",
      "Meta must subscribe this app to the WABA and the messages webhook field separately.",
      "Receipts are retained for 7 days, capped at 1,000 messages / 10 events each. No backfill.",
    ].join("\n"),
    {
      message_id: z.string().min(1).max(512).describe("The wamid returned when the message was sent"),
      fields: z.string().optional().default("id,status,recipient_id,timestamp,errors")
        .describe("Legacy compatibility parameter; ignored. Returns saved receipt and history, without recipient number."),
    },
    { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    async ({ message_id }) => {
      try {
        return jsonResponse(await getDeliveryStatus(message_id));
      } catch {
        return { isError: true, content: [{ type: "text", text: "Delivery receipt storage unavailable. No delivery conclusion can be drawn." }] };
      }
    }
  );
}
