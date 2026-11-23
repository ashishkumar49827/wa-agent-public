# wa-agent: apna WhatsApp AI assistant (Render free tier ready)

Perisclaw-style agent on YOUR WhatsApp number. Runs as a linked device (like WhatsApp Web).

## Features
- AI replies in your self-chat ("Message yourself"), and in any chat or group when you type `/claw <message>`
- Perisclaw-style commands: `/claw`, `/stop` (stop an in-flight reply), `/ignore`
  (reply to a message with /ignore and the agent skips it), `/restart` (reconnect if it hangs)
- Reply to any message in self-chat to give the AI that message as context
- Todos: `/todo add <kaam>` | `/todo list` | `/todo done <id>`
- Reminders: `/remind 10m chai` or `/remind 17:30 call mummy` (fires even hours later)
- Notes: `/note <baat>` | `/notes`
- Search everything: `/find <shabd>` (notes, todos, reminders, chat history)
- Chat labels: type `/claw label <naam>` inside any chat, list with `/labels`
- Daily digest: `/digest 8` sends a morning summary (todos + today's reminders)
- `/clear` resets a chat's memory, `/ping` checks it's alive
- Brain: any OpenAI-compatible LLM API (default: free Gemini API key)
- `/health` endpoint for UptimeRobot keep-alive pings (every 5 min)
- WhatsApp session + agent data (todos/reminders/notes/history) auto-back-up encrypted
  (AES-256-GCM) to a private GitHub repo, so everything survives Render redeploys

## Deploy steps
1. Push this repo to a private GitHub repo (e.g. `youruser/wa-agent`).
2. Make an empty private repo for the backup, e.g. `youruser/wa-agent-session`.
3. Create a GitHub fine-grained token (Settings > Developer settings > Fine-grained tokens):
   access ONLY `wa-agent-session`, permission Contents: Read and write. Copy it.
4. Get a free LLM key: aistudio.google.com > Get API key.
5. On render.com: New > Web Service > connect the `wa-agent` repo > Docker runtime > Free plan.
6. Add Environment variables:
   - `WA_PHONE` = your number with country code, digits only (e.g. 919695114520)
   - `OPENAI_API_KEY` = the key from step 4
   - `SESSION_BACKUP_TOKEN` = token from step 3
   - `SESSION_BACKUP_REPO` = `youruser/wa-agent-session`
   - `SESSION_BACKUP_PASS` = any long passphrase you invent (encrypts the backup)
   (OPENAI_BASE_URL / MODEL / SYSTEM_PROMPT already have defaults in render.yaml)
7. Deploy. Open Logs: you will see `PAIRING CODE for <number>: XXXX-XXXX`.
   On your phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number >
   enter the code. (Codes expire; if it doesn't work, restart the service for a new one.)
8. UptimeRobot: add HTTP monitor, URL `https://<your-service>.onrender.com/health`, interval 5 min.

Then open your own WhatsApp, go to the "Message yourself" chat, and talk to your agent.

## Warnings
- This uses WhatsApp's unofficial Web protocol. WhatsApp can ban the number it runs on.
  Consider a secondary number, not your main one.
- Render free tier: 512 MB RAM, no shell, ephemeral disk (that's why the backup exists).
- Never put the API keys in the code; they live in Render's env vars.
