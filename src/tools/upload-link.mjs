import { z } from "zod";
import { createUploadSession, uploadIntakeEnabled } from "../template-upload-browser.mjs";

export function registerUploadLinkTools(server) {
  server.registerTool(
    "wa_create_template_image_upload_link",
    {
      title: "Create one-time template image upload link",
      description: "Create a 10-minute one-time browser upload URL for a template header image. Requires the exact SHA-256 checksum; uploads are capped at 5 MiB, verified, and never create templates or send messages.",
      inputSchema: {
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        file_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
        content_type: z.enum(["image/png", "image/jpeg"]).optional(),
      },
    },
    async (input) => {
      try {
        if (!uploadIntakeEnabled()) throw new Error("Upload intake is not configured.");
        const session = createUploadSession({
          expectedSha256: input.expected_sha256,
          fileName: input.file_name || "template-header.png",
          contentType: input.content_type || "",
        });
        const base = process.env.PUBLIC_BASE_URL;
        if (typeof base !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(base)) {
          throw new Error("PUBLIC_BASE_URL must be the public HTTPS service URL.");
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              upload_url: `${base}/upload/template-image/${session.token}`,
              expires_at: new Date(session.expiresAt).toISOString(),
              max_bytes: session.maxBytes,
              one_time: true,
              messages_sent: 0,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );
}
