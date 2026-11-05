import { num } from "../shared/config.js";

export const acceptConfig = {
  invitationsUrl: "https://www.linkedin.com/mynetwork/invitation-manager/received/",
  maxPerRun: num("MAX_ACCEPTS_PER_RUN", 25),
  // New invitations trigger a check right away through LinkedIn's realtime channel. These
  // seconds bound the fallback checks in between, in case an event is missed.
  checkEveryMinSec: num("ACCEPT_CHECK_MIN_SEC", 60),
  checkEveryMaxSec: num("ACCEPT_CHECK_MAX_SEC", 120),
};
