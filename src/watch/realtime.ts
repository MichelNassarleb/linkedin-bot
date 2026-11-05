// Listens to LinkedIn's realtime push channel (/realtime/connect, a server-sent event stream
// the page keeps open) and reports which topics had events, e.g. a new message or invitation.
// Playwright cannot read a response that never finishes, so this uses Chrome DevTools
// Protocol streaming on the page's network traffic instead.
import type { Page } from "playwright";

export type RealtimeKind = "message" | "invitation";

// Topic names as they appear in the stream (urn:li-realtime:<topic>:...).
const TOPIC_KINDS: Record<string, RealtimeKind> = {
  messagesTopic: "message",
  conversationsTopic: "message",
  invitationsTopic: "invitation",
};
const TOPIC_PATTERN = new RegExp(`\\b(${Object.keys(TOPIC_KINDS).join("|")})\\b`, "g");

// The protocol fields used here; Playwright's CDP typings do not cover response streaming.
type ResponseReceived = { requestId: string; response: { url: string } };
type DataReceived = { requestId: string; data?: string };
type StreamResult = { bufferedData?: string };

export async function onRealtimeEvent(page: Page, handler: (kind: RealtimeKind) => void): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const streams = new Set<string>();

  const feed = (base64: string | undefined) => {
    if (!base64) return;
    const text = Buffer.from(base64, "base64").toString("utf8");
    // The first event of a connection lists every subscribed topic; it is not news.
    if (text.includes("ClientConnection")) return;
    const kinds = new Set([...text.matchAll(TOPIC_PATTERN)].map((m) => TOPIC_KINDS[m[1]]));
    for (const kind of kinds) handler(kind);
  };

  cdp.on("Network.responseReceived", (event) => {
    const { requestId, response } = event as unknown as ResponseReceived;
    if (!response.url.includes("/realtime/connect")) return;
    streams.add(requestId);
    // Without this call Chrome does not include the stream's data in dataReceived events.
    (cdp.send as (method: string, params: object) => Promise<StreamResult>)("Network.streamResourceContent", { requestId })
      .then((result) => feed(result.bufferedData))
      .catch(() => {});
  });
  cdp.on("Network.dataReceived", (event) => {
    const { requestId, data } = event as unknown as DataReceived;
    if (streams.has(requestId)) feed(data);
  });
  cdp.on("Network.loadingFinished", (event) => streams.delete((event as { requestId: string }).requestId));
  cdp.on("Network.loadingFailed", (event) => streams.delete((event as { requestId: string }).requestId));
}
