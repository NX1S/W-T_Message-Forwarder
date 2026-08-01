const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

(async () => {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan this QR code with WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            waReconnectAttempts = 0;
            const phone = sock.user?.id?.split('@')[0] || 'Unknown';
            const name = sock.user?.name || 'Unknown';
            console.log(`✅ Connected to ${phone} || ${name}`);
            listGroupsAndChannels();
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (!shouldReconnect) {
                console.log('❌ Logged out. Delete auth_info_baileys folder and scan QR again.');
                process.exit(1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    async function listGroupsAndChannels() {
        console.log('⏳ Fetching groups and channels...\n');

        // Fetch all chats
        const chats = await sock.groupFetchAllParticipating().catch(() => ({}));

        const groups = [];
        const channels = [];

        for (const [id, metadata] of Object.entries(chats)) {
            const info = {
                id: id,
                name: metadata.subject || 'Unknown',
                participants: metadata.participants?.length || 0,
            };

            // Channels have @newsletter in their ID or specific properties
            // Groups have @g.us
            if (id.includes('@newsletter')) {
                channels.push(info);
            } else if (id.endsWith('@g.us')) {
                groups.push(info);
            }
        }

        console.log('═'.repeat(60));
        console.log(`📢 GROUPS (${groups.length} found)`);
        console.log('═'.repeat(60));
        groups.forEach((g, i) => {
            console.log(`   ID: ${g.id} || ${g.name}`);
            console.log(`   Participants: ${g.participants}`);
            console.log('');
        });
        console.log('✅ Done. Press Ctrl+C to exit.');
    }

})();