# Message Forwarder

A unified message forwarder that combines **WhatsApp** and **Telegram** listeners to forward all messages to a **Telegram Bot**.

## Features

- 📱 Listen to WhatsApp groups
- 💬 Listen to Telegram groups, channels, and private messages
- 🤖 Forward all messages to Telegram Bot destinations
- 📝 Log all messages per source in `logs/` folder

## Setup

### 1. Prerequisites

Install dependencies:
```bash
npm install
```

### 2. Create `.env` file

Copy and fill in your credentials:
```
API_ID=your_api_id
API_HASH=your_api_hash
STRING_SESSION=your_session_string
BOT_TOKEN=your_telegram_bot_token
```

### 3. Generate Telegram Session String

Run the AutoStringSession script to get your `STRING_SESSION`:
```bash
node "Other Scripts/AutoStringSession.js"
```

Follow the prompts to login with your Telegram account.

### 4. Configure `config.json`

Edit `config.json` to specify your sources and destinations:

```json
{
  "whatsappSources": ["xxx-xxx@g.us", "yyy-yyy@g.us"],
  "telegramSources": [chat_id_1, chat_id_2],
  "telegramDestinations": [destination_chat_id_1, destination_chat_id_2]
}
```

**To find Telegram group/channel IDs:**
- Use group listers (provided in "Other Scripts" folder) or inspection tools to get numeric chat IDs
- Private messages use user IDs (positive numbers for users)

*note:*  
*private chat IDs have **10 digits***   
*groups start with "**-**" + 10 digits*  
*channels start with "**-100**" + 10 digits*  

## Initialization

```bash
npm start
```

Follow the prompts:
1. **WhatsApp**: Scan QR code with your phone (Settings → Linked Devices)
2. **Telegram Self-Bot**: Automatically logs in using your `STRING_SESSION`
3. **Telegram Forwarder Bot**: Automatically connects using your `BOT_TOKEN`

## Important Notes

⚠️ **WhatsApp Limitation**: The WhatsApp listener only works for **groups** 

✅ **Telegram Support**: Works for:
- Groups
- Channels
- Private messages (user accounts)

## Config Format

| Field | Type | Description |
|-------|------|-------------|
| `whatsappSources` | Array | WhatsApp group JIDs (ending in `@g.us`) |
| `telegramSources` | Array | Telegram chat IDs to listen to (groups, channels, users) |
| `telegramDestinations` | Array | Telegram chat IDs where messages are forwarded |

## Logging

All messages are logged to individual files in the `logs/` folder with timestamps and source information.

## Troubleshooting

- **`STRING_SESSION` invalid**: Regenerate using AutoStringSession
- **WhatsApp QR timeout**: Restart and try again. If it didnt work, delete `auth_info_baileys`  folder.
- **Bot not sending messages**: Verify `BOT_TOKEN` and destination chat IDs have proper permissions
- **No messages received**: Check that sources are in `config.json` and listeners are connected. You must also be in the groups and subscribed to the channels.