import { num } from "../shared/config.js";

export const acceptConfig = {
  invitationsUrl: "https://www.linkedin.com/mynetwork/invitation-manager/received/",
  maxPerRun: num("MAX_ACCEPTS_PER_RUN", 25),
  // Seconds between invitation checks; each wait is picked at random in this range.
  checkEveryMinSec: num("ACCEPT_CHECK_MIN_SEC", 30),
  checkEveryMaxSec: num("ACCEPT_CHECK_MAX_SEC", 60),
};
