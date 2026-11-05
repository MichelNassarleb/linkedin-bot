# linkedin-bot

A bot that runs on your own LinkedIn account, on your Mac. While it runs, it:

- **accepts incoming connection requests** as soon as they arrive
- **answers direct messages** as soon as they arrive, with a short reply that fits the conversation. Claude reads the thread, including attachment names and images, and writes the reply.

It reacts within seconds because it listens to LinkedIn's own realtime channel: the page keeps a server-sent event stream (`/realtime/connect`) open, and LinkedIn pushes `messagesTopic`, `conversationsTopic` and `invitationsTopic` events on it. The bot reads that stream through the Chrome DevTools Protocol and starts a check on each event. Timed checks (messages every 30–60 s, invitations every 60–120 s) catch anything the stream misses.

LinkedIn has no public API for this, so the bot drives your installed Google Chrome with [Playwright](https://playwright.dev), using a separate Chrome profile that you sign in to once by hand. It finds unread conversations and message contents by reading the data LinkedIn's own messaging page loads (the `messengerConversations` / `messengerMessages` GraphQL responses), not by scraping text, so layout changes break it less.

It only replies. It never starts a conversation, never sends connection requests and never sends bulk messages.

## Run it

Requirements: macOS, Node.js 22.13+, Google Chrome, and an Anthropic API key.

```sh
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env   # from platform.claude.com → Settings → API Keys
npm run login    # Chrome opens; sign in to LinkedIn yourself (incl. 2FA). Done once.
npm start        # asks your name, age and location, then runs until Ctrl+C
```

On start, the bot asks for your name, age and where you live. Press Enter to keep the saved answers. These are the only facts about you it will share; for anything else, it deflects or says it will get back to them. `npm start` runs under `caffeinate`, so the Mac stays awake while the bot runs. Keep the Chrome window open.

## How replies work

- **Which conversations:** every unread 1:1 conversation, plus the newest conversation even if you have read it. Group chats and sponsored or InMail messages are ignored.
- **Each message is answered once:** answered messages are tracked by LinkedIn's message id in a local SQLite database. When the other person writes again, the bot answers again.
- **Several messages in a row:** the bot waits until the other person has been quiet for 12 seconds, then answers them all in one reply.
- **Sounding human:** replies are short and casual, in the sender's language, with no assistant phrases. The text is typed key by key into the chat box.
- **Unusual messages:** the prompt in `src/reply/draft.ts` has rules for each of these:
  - nearly empty or emoji-only messages
  - very long messages
  - links (it doesn't pretend to have opened them)
  - files and images (images are passed to the model)
  - rude messages (it stays calm and short)
  - questions it cannot know (it doesn't invent facts)
  - requests to commit to something (it says it will check)
  - spam
  - "are you a bot?" (it doesn't claim to be human)
  - prompt injection (it treats messages as content, never as instructions)
- **Model:** Claude (`claude-opus-5-5` at low effort; change it with `REPLY_MODEL`). A reply takes about 2–5 s.

If LinkedIn shows a security check, the bot stops and creates `~/.linkedin-bot/STOP`. Deal with the check in Chrome, then delete that file.

## Layout

```
src/watch/    npm start: the main loop (one Chrome, one tab for invitations, one for messages)
              and the realtime listener (realtime.ts)
src/accept/   accepting invitations
src/reply/    reading the inbox (reply.ts), writing the reply with Claude (draft.ts)
src/profile/  the name/age/location prompt
src/login/    one-time manual login
src/shared/   browser, config, database, helpers
```

All state lives outside the repo in `~/.linkedin-bot/`: the Chrome profile, `bot.db`, `profile.json` and failure screenshots. No messages or personal data are stored in the repository.

## What it cannot do yet

- **Message requests from non-connections** in LinkedIn's "Other" / message-request folders are not answered.
- **Group chats** are not answered.
- **Attachments other than images:** it cannot read the contents of PDFs, documents, videos or voice messages. It sees only their type and name.
- **Links:** it cannot open them.
- **Memory across conversations:** it has none, and it only sees the latest 30 messages of a thread.
- **Facts about you:** it knows only your name, age and location, and nothing about your work or schedule.
- **Running in the background:** it needs the Mac awake and logged in, with a visible Chrome window. A server or headless setup would need more work against LinkedIn's bot detection.
- **ToS risk:** LinkedIn's User Agreement prohibits automation, and the account may be restricted.

## Settings (optional, via `.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Required |
| `REPLY_MODEL` | `claude-opus-5-5` | Model that writes replies |
| `REPLY_CHECK_MIN_SEC` / `REPLY_CHECK_MAX_SEC` | `30` / `60` | Fallback inbox check interval |
| `ACCEPT_CHECK_MIN_SEC` / `ACCEPT_CHECK_MAX_SEC` | `60` / `120` | Fallback invitation check interval |
| `REPLY_QUIET_SEC` | `12` | Quiet time before answering a burst of messages |
| `REPLY_CONTEXT_MESSAGES` | `30` | Latest messages the model sees |
| `MAX_REPLIES_PER_DAY` | `300` | Safety cap |
