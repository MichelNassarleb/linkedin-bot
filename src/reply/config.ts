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
  // Seconds between inbox checks; each wait is picked at random in this range.
  checkEveryMinSec: num("REPLY_CHECK_MIN_SEC", 10),
  checkEveryMaxSec: num("REPLY_CHECK_MAX_SEC", 20),
  maxPerCheck: num("MAX_REPLIES_PER_CHECK", 10),
  maxPerDay: num("MAX_REPLIES_PER_DAY", 300),
};
