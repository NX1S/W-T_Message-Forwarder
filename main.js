// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED MESSAGE FORWARDER — WhatsApp + Telegram → Telegram Bot
// No filters. All messages from whitelisted sources are forwarded.
// Sequential startup: Telegram Bot → Telegram Self-Bot → WhatsApp
// Logs all messages to individual files per source in logs/ folder
// ═══════════════════════════════════════════════════════════════════════════════

const dotenv = require('dotenv');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions/index.js');
const { NewMessage } = require('telegram/events/index.js');

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG_FILE = 'config.json';
const DATA_FILE = 'data.json';
const LOGS_DIR = 'logs';
const WHATSAPP_AUTH_DIR = 'auth_info_baileys';

const defaultConfig = {
    whatsappSources: [],
    telegramSources: [],
    telegramDestinations: []
};

let config = {};
let messageQueue = [];
let isProcessingQueue = false;

let whatsappSock = null;
let telegramSelfClient = null;
let telegramBotClient = null;

let waReconnectAttempts = 0;
let waReconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function ensureConfigExists() {
    try {
        fs.accessSync(CONFIG_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
        console.log(`[${getTimestamp()}][CONFIG] Created default ${CONFIG_FILE}`);
    }
}

function loadConfig() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        config = { ...defaultConfig, ...JSON.parse(data) };
        return config;
    } catch (err) {
        console.error(`[${getTimestamp()}][CONFIG] Error loading config:`, err.message);
        return defaultConfig;
    }
}

function ensureDataExists() {
    try {
        fs.accessSync(DATA_FILE, fs.constants.F_OK);
    } catch {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ stats: {} }, null, 2), 'utf8');
    }
}

function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{"stats":{}}');
    } catch {
        return { stats: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        console.log(`[${getTimestamp()}][SYSTEM] Created logs directory: ${LOGS_DIR}`);
    }
}

function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .trim()
        .substring(0, 100);
}

function logMessage(source, platform, text) {
    const safeName = sanitizeFilename(source);
    const logFile = path.join(LOGS_DIR, `${safeName}.log`);
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${platform.toUpperCase()}] ${text}\n`;

    try {
        fs.appendFileSync(logFile, line, 'utf8');
    } catch (err) {
        console.error(`[${getTimestamp()}][ERROR] Failed to write log:`, err.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE QUEUE & FORWARDING
// ═══════════════════════════════════════════════════════════════════════════════

async function queueMessage(source, platform, text) {
    messageQueue.push({ source, platform, text, timestamp: Date.now() });
    console.log(`[${getTimestamp()}][QUEUE] Message from ${platform}: ${source}`);

    // Log to file
    logMessage(source, platform, text);

    const data = loadData();
    if (!data.stats[source]) data.stats[source] = { platform, count: 0 };
    data.stats[source].count++;
    data.stats[source].lastMessage = getTimestamp();
    saveData(data);

    processQueue();
}

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!telegramBotClient || !telegramBotClient.connected) return;

    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const item = messageQueue.shift();
        const formattedText = `📡 *${item.platform.toUpperCase()}* → *${item.source}*\n\n${item.text}`;

        for (const destId of config.telegramDestinations) {
            try {
                await telegramBotClient.sendMessage(destId, { message: formattedText });
                console.log(`[${getTimestamp()}][SEND] Forwarded to ${destId}`);
            } catch (err) {
                console.error(`[${getTimestamp()}][ERROR] Failed to send to ${destId}:`, err.message);
            }
        }
    }

    isProcessingQueue = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP
// ═══════════════════════════════════════════════════════════════════════════════

function getWABackoffDelay(attempt) {
    return Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
}

function clearWAReconnectTimer() {
    if (waReconnectTimer) {
        clearTimeout(waReconnectTimer);
        waReconnectTimer = null;
    }
}

async function connectWhatsApp() {
    clearWAReconnectTimer();

    try {
        const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

        whatsappSock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            syncFullHistory: false,
        });

        whatsappSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 WhatsApp: Scan this QR code → Settings → Linked Devices:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                waReconnectAttempts = 0;
                const phone = whatsappSock.user?.id?.split('@')[0] || 'Unknown';
                const name = whatsappSock.user?.name || 'Unknown';
                console.log(`[${getTimestamp()}][WHATSAPP] ✅ Connected and listening to ${phone} || ${name}`);

                whatsappSock.ev.on('messages.upsert', async ({ messages }) => {
                    for (const msg of messages) {
                        const jid = msg.key.remoteJid;
                        if (!jid || !jid.endsWith('@g.us')) continue;
                        if (!config.whatsappSources.includes(jid)) continue;

                        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                        if (!text) continue;

                        console.log(`[${getTimestamp()}][WHATSAPP] Message from ${jid}`);

                        let sourceName = jid;
                        try {
                            const meta = await whatsappSock.groupMetadata(jid);
                            sourceName = meta.subject || jid;
                        } catch { /* ignore */ }

                        await queueMessage(sourceName, 'whatsapp', text);
                    }
                });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (!shouldReconnect) {
                    console.log(`[${getTimestamp()}][WHATSAPP] ❌ Logged out. Delete ${WHATSAPP_AUTH_DIR} and restart.`);
                    waReconnectAttempts = MAX_RECONNECT_ATTEMPTS + 1;
                    return;
                }

                console.log(`[${getTimestamp()}][WHATSAPP] ⚠️ Disconnected: ${lastDisconnect?.error?.message || 'Unknown'}`);
                scheduleWAReconnect();
            }
        });

        whatsappSock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error(`[${getTimestamp()}][WHATSAPP] Connection error:`, err.message);
        scheduleWAReconnect();
    }
}

function scheduleWAReconnect() {
    clearWAReconnectTimer();
    if (waReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[${getTimestamp()}][WHATSAPP] Max reconnect attempts reached.`);
        return;
    }

    const delay = getWABackoffDelay(waReconnectAttempts);
    waReconnectAttempts++;
    console.log(`[${getTimestamp()}][WHATSAPP] Reconnecting in ${(delay / 1000).toFixed(1)}s... (${waReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    waReconnectTimer = setTimeout(() => connectWhatsApp(), delay);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM SELF-BOT (Listener)
// ═══════════════════════════════════════════════════════════════════════════════

async function connectTelegramSelfBot() {
    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    const sessionString = process.env.STRING_SESSION || '';

    if (!sessionString) {
        console.error(`[${getTimestamp()}][TELEGRAM] STRING_SESSION not found in .env!`);
        console.error(`[${getTimestamp()}][TELEGRAM] Run your session generator script first.`);
        process.exit(1);
    }

    const stringSession = new StringSession(sessionString);
    telegramSelfClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    telegramSelfClient.setLogLevel('none');

    try {
        await telegramSelfClient.connect();

        const me = await telegramSelfClient.getMe();
        console.log(`[${getTimestamp()}][TELEGRAM] ✅ Self-bot connected as @${me.username || me.firstName}!`);

        telegramSelfClient.addEventHandler(async (event) => {
            const msg = event.message;
            if (!msg || !msg.message) return;

            let sourceId;
            let sourceType = 'unknown';

            if (msg.peerId?.channelId) {
                sourceId = msg.peerId.channelId;
                sourceType = 'channel';
            } else if (msg.peerId?.chatId) {
                sourceId = msg.peerId.chatId;
                sourceType = 'group';
            } else if (msg.peerId?.userId) {
                sourceId = msg.peerId.userId;
                sourceType = 'private';
            } else {
                return;
            }

            let sourceName = String(sourceId);
            try {
                const entity = await telegramSelfClient.getEntity(msg.peerId);
                sourceName = entity.title || entity.firstName || entity.username || String(sourceId);
            } catch { sourceName = String(sourceId); }

            console.log(`[${getTimestamp()}][TELEGRAM] [${sourceType.toUpperCase()}] Message from ${sourceName} (${sourceId})`);
            await queueMessage(`${sourceName} [${sourceType}]`, 'telegram', msg.message);

        }, new NewMessage({ chats: config.telegramSources }));

    } catch (err) {
        console.error(`[${getTimestamp()}][TELEGRAM] Self-bot connection failed:`, err.message);
        setTimeout(connectTelegramSelfBot, 10000);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT (Forwarder)
// ═══════════════════════════════════════════════════════════════════════════════

async function connectTelegramBot() {
    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    const botToken = process.env.BOT_TOKEN;

    if (!botToken) {
        console.error(`[${getTimestamp()}][TELEGRAM] BOT_TOKEN not set in .env!`);
        return;
    }

    telegramBotClient = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
    telegramBotClient.setLogLevel('none');

    try {
        await telegramBotClient.start({ botAuthToken: botToken });
        console.log(`[${getTimestamp()}][TELEGRAM] ✅ Forwarder bot connected!`);
        processQueue();
    } catch (err) {
        console.error(`[${getTimestamp()}][TELEGRAM] Bot connection failed:`, err.message);
        setTimeout(connectTelegramBot, 10000);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function getTimestamp(date = new Date()) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const hh = String(hours).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${minutes}:${seconds} ${ampm}`;
}

function cleanup() {
    console.log(`\n[${getTimestamp()}][SYSTEM] Shutting down gracefully...`);
    clearWAReconnectTimer();
    if (whatsappSock) whatsappSock.end();
    if (telegramSelfClient) telegramSelfClient.disconnect();
    if (telegramBotClient) telegramBotClient.disconnect();
    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN — SEQUENTIAL STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     UNIFIED MESSAGE FORWARDER v2.4                           ║');
    console.log('║     WhatsApp + Telegram → Telegram Bot                       ║');
    console.log('║     Logs all messages to logs/ folder per source             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    ensureConfigExists();
    ensureDataExists();
    loadConfig();
    ensureLogsDir();

    console.log(`[${getTimestamp()}][SYSTEM] WhatsApp sources: ${config.whatsappSources.length}`);
    console.log(`[${getTimestamp()}][SYSTEM] Telegram sources: ${config.telegramSources.length}`);
    console.log(`[${getTimestamp()}][SYSTEM] Destinations: ${config.telegramDestinations.length}\n`);

    // ─── STEP 1: Start Telegram Bot (Forwarder) ───
    console.log(`[${getTimestamp()}][SYSTEM] Step 1/3: Starting Telegram Forwarder Bot...\n`);
    await connectTelegramBot();

    // ─── STEP 2: Start Telegram Self-Bot (Listener) ───
    console.log(`\n[${getTimestamp()}][SYSTEM] Step 2/3: Starting Telegram Self-Bot Listener...\n`);
    await connectTelegramSelfBot();

    // ─── STEP 3: Start WhatsApp ───
    console.log(`\n[${getTimestamp()}][SYSTEM] Step 3/3: Starting WhatsApp Listener...\n`);
    await connectWhatsApp();

    console.log(`\n[${getTimestamp()}][SYSTEM] ✅ All services running. Waiting for messages...\n`);
})();
