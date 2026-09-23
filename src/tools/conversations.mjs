import { z } from "zod";
import { callApi, errorResponse, jsonResponse } from "../api.mjs";

export function registerConversationTools(server) {
  // ── Facebook Page Conversations ──────────────────────────────

  server.tool(
    "fb_list_conversations",
    "List recent Facebook Page conversations (Messenger inbox). Returns participant names, message count, and last update time. Use to find leads who messaged the Page.",
    {
      page_id: z.string().describe("Facebook Page ID. Falls back to META_PAGE_ID env var if omitted.").optional(),
      limit: z.number().min(1).max(100).default(25).describe("Number of conversations to return (max 100, default 25)"),
      after: z.string().describe("Pagination cursor from a previous response").optional(),
    },
    async ({ page_id, limit, after }) => {
      const pid = page_id || process.env.META_PAGE_ID;
      if (!pid) return errorResponse({ error: { message: "No page_id provided and META_PAGE_ID env var not set", kind: "config_error" } });
      let path = `/${pid}/conversations?fields=participants,updated_time,message_count,id&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await callApi("GET", path);
      if (data.error) return errorResponse(data);
      const conversations = (data.data || []).map((conv) => ({
        conversation_id: conv.id,
        participants: (conv.participants?.data || []).map((p) => ({ name: p.name || "", id: p.id || "" })),
        message_count: conv.message_count,
        updated_time: conv.updated_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return jsonResponse({ conversations, count: conversations.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "fb_get_conversation_messages",
    "Get messages from a specific Facebook Page conversation.",
    {
      conversation_id: z.string().describe("The conversation ID from fb_list_conversations"),
      limit: z.number().min(1).max(100).default(10).describe("Number of messages to return (max 100, default 10)"),
      after: z.string().describe("Pagination cursor for next page").optional(),
    },
    async ({ conversation_id, limit, after }) => {
      let path = `/${conversation_id}/messages?fields=message,from,created_time,attachments&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await callApi("GET", path);
      if (data.error) return errorResponse(data);
      const messages = (data.data || []).map((msg) => ({
        id: msg.id,
        from: msg.from || {},
        message: msg.message || "",
        created_time: msg.created_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return jsonResponse({ messages, count: messages.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "fb_get_participant_profile",
    "Get a Facebook user profile from a Page conversation (name, profile pic). Only works for users who have messaged the Page.",
    {
      user_id: z.string().describe("The participant user ID from fb_list_conversations or fb_get_conversation_messages"),
    },
    async ({ user_id }) => {
      const data = await callApi("GET", `/${user_id}?fields=name,first_name,last_name,profile_pic`);
      if (data.error) return errorResponse(data);
      return jsonResponse(data);
    }
  );

  // ── Instagram Direct Conversations ──────────────────────────

  server.tool(
    "ig_list_conversations",
    "List recent Instagram Direct conversations. Returns participant usernames and last update time. Use to find leads who messaged the Instagram account.",
    {
      ig_user_id: z.string().describe("Instagram Business Account ID. Falls back to META_INSTAGRAM_ACCOUNT_ID env var if omitted.").optional(),
      limit: z.number().min(1).max(100).default(25).describe("Number of conversations to return (max 100, default 25)"),
      after: z.string().describe("Pagination cursor from a previous response").optional(),
    },
    async ({ ig_user_id, limit, after }) => {
      const igId = ig_user_id || process.env.META_INSTAGRAM_ACCOUNT_ID;
      if (!igId) return errorResponse({ error: { message: "No ig_user_id provided and META_INSTAGRAM_ACCOUNT_ID env var not set", kind: "config_error" } });
      let path = `/${igId}/conversations?fields=participants,updated_time,id&platform=instagram&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await callApi("GET", path);
      if (data.error) return errorResponse(data);
      const conversations = (data.data || []).map((conv) => ({
        conversation_id: conv.id,
        participants: (conv.participants?.data || []).map((p) => ({ name: p.name || "", username: p.username || "", id: p.id || "" })),
        updated_time: conv.updated_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return jsonResponse({ conversations, count: conversations.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );

  server.tool(
    "ig_get_conversation_messages",
    "Get messages from a specific Instagram Direct conversation.",
    {
      conversation_id: z.string().describe("The conversation ID from ig_list_conversations"),
      limit: z.number().min(1).max(100).default(10).describe("Number of messages to return (max 100, default 10)"),
      after: z.string().describe("Pagination cursor for next page").optional(),
    },
    async ({ conversation_id, limit, after }) => {
      let path = `/${conversation_id}/messages?fields=message,from,created_time&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await callApi("GET", path);
      if (data.error) return errorResponse(data);
      const messages = (data.data || []).map((msg) => ({
        id: msg.id,
        from: msg.from || {},
        message: msg.message || "",
        created_time: msg.created_time,
      }));
      const paging = data.paging || {};
      const nextCursor = paging.cursors?.after || null;
      const hasMore = !!paging.next;
      return jsonResponse({ messages, count: messages.length, has_more: hasMore, next_cursor: hasMore ? nextCursor : null });
    }
  );
}
