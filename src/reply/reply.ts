// Answers 1:1 conversations: every unread one, plus the newest one even if it is read.
// Claude reads the thread (text, attachment names and images) and writes the reply.
// Each incoming message is answered at most once.
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { Profile } from "../profile/profile.js";
import { config } from "../shared/config.js";
import { replyConfig } from "./config.js";
import { isMessageHandled, recordMessage, repliesSince } from "./db.js";
import { draftReply, type Image, type TranscriptLine } from "./draft.js";
import { assertUsable, HaltError, log, randomInt, sleep } from "../shared/runtime.js";

// LinkedIn messaging markup for an open thread. If sending or marking unread
// fails, check these against the page first.
const SEL = {
  messageList: ".msg-s-message-list",
  messageItem: ".msg-s-event-listitem",
  // LinkedIn marks messages written by the other side with this modifier.
  messageFromOtherClass: "msg-s-event-listitem--other",
  messageBody: ".msg-s-event-listitem__body",
  threadTitle: ".msg-entity-lockup__entity-title",
  threadActions: ".msg-thread .msg-thread-actions__control",
  // The main thread's composer, not the one in the floating messaging popup.
  composer: ".msg-form__contenteditable:not(.msg-overlay-container .msg-form__contenteditable)",
  // Only shown when "Press Enter to Send" is off.
  sendButton: ".msg-form__send-button, .msg-form__send-btn",
};

// The inbox loads its conversation list and each thread's messages through these GraphQL
// queries. Their data has the unread state, senders, message text and attachments.
const CONVERSATIONS_QUERY = "messengerConversations";
const MESSAGES_QUERY = "messengerMessages";

type Conversation = {
  threadId: string;
  url: string;
  unreadCount: number;
  read: boolean;
  groupChat: boolean;
  categories: string[];
};

type Attachment = { kind: string; name: string; imageUrl: string | null };

type Message = {
  // Stable id of the message; used to remember which messages were answered.
  key: string;
  conversationUrn: string;
  senderUrn: string;
  senderName: string;
  text: string;
  attachments: Attachment[];
  deliveredAt: number;
};

const threadIdFrom = (url: string | null) => url?.match(/\/messaging\/thread\/([^/?#]+)/)?.[1] ?? null;
const isUnread = (c: Conversation) => c.unreadCount > 0 || !c.read;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
const textOf = (v: unknown): string => {
  const s = asRecord(v)?.text;
  return typeof s === "string" ? s : "";
};

function findConversations(node: unknown, found: Conversation[] = [], depth = 0): Conversation[] {
  const o = asRecord(node);
  if (depth > 12 || !o) return found;
  const threadId = typeof o.conversationUrl === "string" ? threadIdFrom(o.conversationUrl) : null;
  if (threadId && typeof o.unreadCount === "number") {
    found.push({
      threadId,
      url: o.conversationUrl as string,
      unreadCount: o.unreadCount,
      read: o.read !== false,
      groupChat: o.groupChat === true,
      categories: Array.isArray(o.categories) ? o.categories.filter((c): c is string => typeof c === "string") : [],
    });
  }
  for (const value of Object.values(o)) findConversations(value, found, depth + 1);
  return found;
}

// Readable names for the keys LinkedIn uses in a message's renderContent.
const ATTACHMENT_KINDS: Record<string, string> = {
  file: "file",
  vectorImage: "image",
  video: "video",
  audio: "voice message",
  externalMedia: "GIF or sticker",
  repostedContent: "shared post",
  hostUrnData: "shared item",
  forwardedMessageContent: "forwarded message",
};

// The largest rendition of a LinkedIn image ({rootUrl, artifacts[]}) anywhere under node.
function findImageUrl(node: unknown, depth = 0): string | null {
  const o = asRecord(node);
  if (depth > 6 || !o) return null;
  if (typeof o.url === "string" && typeof o.mediaType === "string" && o.mediaType.startsWith("image/")) return o.url;
  if (typeof o.rootUrl === "string" && Array.isArray(o.artifacts)) {
    const best = o.artifacts
      .map(asRecord)
      .filter((a) => typeof a?.fileIdentifyingUrlPathSegment === "string")
      .sort((a, b) => Number(b?.width ?? 0) - Number(a?.width ?? 0))[0];
    if (best) return `${o.rootUrl}${best.fileIdentifyingUrlPathSegment}`;
  }
  for (const value of Object.values(o)) {
    const url = findImageUrl(value, depth + 1);
    if (url) return url;
  }
  return null;
}

function findAttachments(o: Record<string, unknown>): Attachment[] {
  if (!Array.isArray(o.renderContent)) return [];
  const found: Attachment[] = [];
  for (const item of o.renderContent) {
    for (const [key, value] of Object.entries(asRecord(item) ?? {})) {
      const content = asRecord(value);
      if (!content || key.startsWith("$")) continue;
      found.push({
        kind: ATTACHMENT_KINDS[key] ?? key,
        name: typeof content.name === "string" ? content.name : "",
        imageUrl: findImageUrl(content),
      });
    }
  }
  return found;
}

function findMessages(node: unknown, found: Message[] = [], depth = 0): Message[] {
  const o = asRecord(node);
  if (depth > 14 || !o) return found;
  const sender = asRecord(o.sender);
  if (typeof o.backendConversationUrn === "string" && typeof sender?.hostIdentityUrn === "string") {
    const member = asRecord(asRecord(sender.participantType)?.member);
    const deliveredAt = typeof o.deliveredAt === "number" ? o.deliveredAt : 0;
    found.push({
      key: typeof o.entityUrn === "string" ? o.entityUrn : `${o.backendConversationUrn}@${deliveredAt}`,
      conversationUrn: o.backendConversationUrn,
      senderUrn: sender.hostIdentityUrn,
      senderName: [textOf(member?.firstName), textOf(member?.lastName)].filter(Boolean).join(" "),
      text: textOf(o.body),
      attachments: findAttachments(o),
      deliveredAt,
    });
  }
  for (const value of Object.values(o)) findMessages(value, found, depth + 1);
  return found;
}

export type Inbox = {
  conversations: Map<string, Conversation>;
  // Your own profile URN, taken from the inbox query's mailboxUrn.
  me: string | null;
  messages: Map<string, Message>;
};

const queryIdOf = (url: URL) => url.searchParams.get("queryId") ?? "";
const isMessagingQuery = (url: URL, query: string) =>
  url.pathname.includes("/voyagerMessagingGraphQL/") && queryIdOf(url).startsWith(query);

// Collects the inbox data LinkedIn loads into this page. Attach once, before the first check.
export function watchInbox(page: Page): Inbox {
  const inbox: Inbox = { conversations: new Map(), me: null, messages: new Map() };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!isMessagingQuery(url, CONVERSATIONS_QUERY)) return;
    inbox.me ??= decodeURIComponent(url.search).match(/mailboxUrn:(urn:li:fsd_profile:[A-Za-z0-9_-]+)/)?.[1] ?? null;
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    const isConversations = isMessagingQuery(url, CONVERSATIONS_QUERY);
    if (!isConversations && !isMessagingQuery(url, MESSAGES_QUERY)) return;
    try {
      const body = await response.json();
      if (isConversations) for (const c of findConversations(body)) inbox.conversations.set(c.threadId, c);
      // Conversation data also carries each thread's latest message.
      for (const m of findMessages(body)) inbox.messages.set(m.key, m);
    } catch {
      // Not JSON, or the page navigated away before the body was read.
    }
  });
  return inbox;
}

function threadMessages(inbox: Inbox, threadId: string): Message[] {
  return [...inbox.messages.values()]
    .filter((m) => m.conversationUrn.includes(threadId))
    .sort((a, b) => a.deliveredAt - b.deliveredAt);
}

// Reasons decided from the conversation data alone; these threads are never opened.
function listSkipReason(c: Conversation): string | null {
  if (c.groupChat) return "group chat";
  if (c.categories.includes("INMAIL")) return "InMail or sponsored";
  if (!c.categories.includes("INBOX")) return "not in inbox";
  return null;
}

async function openThread(page: Page, c: Conversation): Promise<void> {
  if (threadIdFrom(page.url()) !== c.threadId) {
    await page.goto(c.url, { waitUntil: "domcontentloaded" });
  }
  await page.locator(SEL.messageList).waitFor({ state: "visible", timeout: 15_000 });
  await sleep(randomInt(1_000, 2_000));
}

async function threadTitle(page: Page): Promise<string> {
  return (await page.locator(SEL.threadTitle).first().innerText().catch(() => "")).trim();
}

const IMAGE_TYPES = new Set<Image["mediaType"]>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 4_500_000;
const MAX_IMAGES = 4;

// Downloads an image with the browser's cookies, so LinkedIn-hosted media loads.
async function downloadImage(page: Page, url: string): Promise<Image | null> {
  try {
    const response = await page.context().request.get(url, { timeout: 15_000 });
    const mediaType = (response.headers()["content-type"] ?? "").split(";")[0].trim() as Image["mediaType"];
    if (!response.ok() || !IMAGE_TYPES.has(mediaType)) return null;
    const body = await response.body();
    return body.length <= MAX_IMAGE_BYTES ? { mediaType, data: body.toString("base64") } : null;
  } catch {
    return null;
  }
}

function describe(m: Message): string {
  const parts = m.attachments.map((a) => (a.name ? `${a.kind} "${a.name}"` : a.kind));
  const text = m.text.trim();
  if (parts.length === 0) return text || "[empty message]";
  return `${text}${text ? " " : ""}[sent ${parts.join(", ")}]`;
}

type Thread = { lines: TranscriptLine[]; lastKey: string; lastFromMe: boolean };

// The open thread's latest messages, oldest first. Uses the message data; falls back to the markup.
async function readThread(page: Page, inbox: Inbox, c: Conversation, otherName: string): Promise<Thread | null> {
  const messages = threadMessages(inbox, c.threadId).slice(-replyConfig.contextMessages);
  const last = messages.at(-1);
  if (inbox.me && last) {
    // Images are fetched only for the unanswered messages after your last one.
    const lastMine = messages.findLastIndex((m) => m.senderUrn === inbox.me);
    let imageBudget = MAX_IMAGES;
    const lines: TranscriptLine[] = [];
    for (const [i, m] of messages.entries()) {
      const fromMe = m.senderUrn === inbox.me;
      const images: Image[] = [];
      if (i > lastMine) {
        for (const a of m.attachments) {
          if (!a.imageUrl || imageBudget <= 0) continue;
          const image = await downloadImage(page, a.imageUrl);
          if (image) {
            images.push(image);
            imageBudget--;
          }
        }
      }
      lines.push({ fromMe, name: m.senderName || (fromMe ? "" : otherName), text: describe(m), images });
    }
    return { lines, lastKey: last.key, lastFromMe: last.senderUrn === inbox.me };
  }

  const items = (await page.locator(SEL.messageItem).all()).slice(-replyConfig.contextMessages);
  const lines: TranscriptLine[] = [];
  for (const item of items) {
    const fromMe = !((await item.getAttribute("class")) ?? "").includes(SEL.messageFromOtherClass);
    const text = (await item.locator(SEL.messageBody).first().innerText().catch(() => "")).trim();
    lines.push({ fromMe, name: fromMe ? "" : otherName, text: text || "[attachment or non-text message]", images: [] });
  }
  const lastLine = lines.at(-1);
  if (!lastLine) return null;
  return { lines, lastKey: `${c.threadId}:dom:${lines.length}:${lastLine.text.slice(0, 80)}`, lastFromMe: lastLine.fromMe };
}

async function sendReply(page: Page, text: string): Promise<void> {
  const composer = page.locator(SEL.composer).first();
  await composer.click();
  // LinkedIn keeps unsent drafts; clear any left by an earlier failed attempt.
  await composer.fill("");
  await sleep(randomInt(300, 800));
  // Enter would send early, so line breaks are typed as Shift+Enter.
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (i > 0) await composer.press("Shift+Enter");
    await composer.pressSequentially(line, { delay: randomInt(25, 70) });
  }
  await sleep(randomInt(300, 800));

  // isVisible does not wait, unlike isEnabled; in "Press Enter to Send" mode there is no button.
  const sendButton = page.locator(SEL.sendButton).first();
  if ((await sendButton.isVisible()) && (await sendButton.isEnabled())) await sendButton.click();
  else await composer.press("Enter");

  // The composer empties once LinkedIn accepts the message.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await composer.innerText()).trim() === "") return;
    await sleep(500);
  }
  throw new Error("Message was not confirmed as sent (composer still has text).");
}

// Viewing a thread marks it read; put the unread dot back on threads the bot did not answer,
// so you still notice them and the next check tries them again.
async function markUnread(page: Page, label: string): Promise<void> {
  try {
    await page.locator(SEL.threadActions).first().click({ timeout: 5_000 });
    await sleep(randomInt(300, 700));
    await page.getByText("Mark as unread", { exact: true }).filter({ visible: true }).first().click({ timeout: 5_000 });
    await sleep(randomInt(500, 1_000));
  } catch {
    log(`Could not mark "${label}" unread again.`);
  }
}

// Reloads the inbox and answers what needs an answer. Returns the number of replies sent.
export async function answerMessages(page: Page, inbox: Inbox, runId: number, profile: Profile): Promise<number> {
  const remainingToday = replyConfig.maxPerDay - repliesSince(startOfToday());
  if (remainingToday <= 0) {
    log(`Daily limit of ${replyConfig.maxPerDay} replies reached.`);
    return 0;
  }
  const limit = Math.min(replyConfig.maxPerCheck, remainingToday);

  const { conversations } = inbox;
  conversations.clear();
  await page.goto(replyConfig.messagingUrl, { waitUntil: "domcontentloaded" });
  await assertUsable(page);
  const deadline = Date.now() + 20_000;
  while (conversations.size === 0 && Date.now() < deadline) await sleep(300);
  if (conversations.size === 0) throw new Error(`No ${CONVERSATIONS_QUERY} data seen; LinkedIn may have changed its inbox API.`);
  // LinkedIn opens the newest thread on its own; let that settle.
  await sleep(randomInt(1_500, 2_500));

  // Unread threads, plus the thread LinkedIn opened on its own (the newest one), even if it
  // is read: the bot answers it too when its last message is from the other person.
  const autoOpenedId = threadIdFrom(page.url());
  const candidates = [...conversations.values()].filter((c) => isUnread(c) || c.threadId === autoOpenedId);

  let replied = 0;
  for (const c of candidates) {
    if (replied >= limit || existsSync(config.stopFile)) break;
    const wasUnread = isUnread(c);

    if (listSkipReason(c)) {
      if (wasUnread && c.threadId === threadIdFrom(page.url())) await markUnread(page, c.threadId);
      continue;
    }

    // The inbox data usually has each thread's latest message, so most threads that
    // need nothing are skipped without opening them.
    const known = threadMessages(inbox, c.threadId).at(-1);
    if (known && (isMessageHandled(known.key) || known.senderUrn === inbox.me)) continue;
    // They may still be typing more messages; answer them together on a later check.
    if (known && Date.now() - known.deliveredAt < replyConfig.quietSec * 1_000) continue;

    try {
      await openThread(page, c);
    } catch {
      // Not recorded, so the next check tries again.
      await assertUsable(page);
      log(`Skip ${c.threadId}: thread did not load`);
      continue;
    }
    await assertUsable(page);
    const name = await threadTitle(page);
    const label = name || c.threadId;

    let sent = false;
    const thread = await readThread(page, inbox, c, name);
    if (thread && !thread.lastFromMe && !isMessageHandled(thread.lastKey)) {
      try {
        const draft = await draftReply(profile, name, thread.lines);
        await sendReply(page, draft.text);
        await assertUsable(page);
        recordMessage(runId, thread.lastKey, c.threadId, name || null, "replied", draft.reason, draft.text);
        sent = true;
        replied++;
        log(`Replied to ${label}: "${draft.text}"`);
      } catch (error) {
        const fatal =
          error instanceof HaltError ||
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError;
        if (fatal) throw error;
        // Not recorded, so the next check tries again.
        log(`Could not answer ${label}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (wasUnread && !sent) await markUnread(page, label);
    await sleep(randomInt(1_000, 2_500));
  }
  return replied;
}
