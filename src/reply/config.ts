import { num } from "../shared/config.js";

export const replyConfig = {
  messagingUrl: "https://www.linkedin.com/messaging/",
  // Claude model that reads each thread and writes the reply.
  model: process.env.REPLY_MODEL ?? "claude-opus-5-5",
  // How many of the latest messages in a thread the model sees.
  contextMessages: num("REPLY_CONTEXT_MESSAGES", 30),
  // Wait until the other person has been quiet this long, so several messages
  // sent in a row get one answer.
  quietSec: num("REPLY_QUIET_SEC", 12),
  // New messages trigger a check right away through LinkedIn's realtime channel. These
  // seconds bound the fallback checks in between, in case an event is missed.
  checkEveryMinSec: num("REPLY_CHECK_MIN_SEC", 30),
  checkEveryMaxSec: num("REPLY_CHECK_MAX_SEC", 60),
  maxPerCheck: num("MAX_REPLIES_PER_CHECK", 10),
  maxPerDay: num("MAX_REPLIES_PER_DAY", 300),
};
