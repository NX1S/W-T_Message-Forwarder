const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const dotenv = require("dotenv");

dotenv.config(); // Load .env variables

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.STRING_SESSION);

const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
});

(async () => {
    await client.start({ botAuthToken: null });
    console.log("✅ Connected with saved session!");

    // Fetch all dialogs
    const dialogs = await client.getDialogs();

    // Filter groups/supergroups
    const groupsAndSupergroups = dialogs.filter(d => d.isGroup || d.isSupergroup);
    console.log("\nGroups you can track:");
    groupsAndSupergroups.forEach(g => console.log(`${g.title} | ID: ${g.id}`));

    // Filter channels
    const channels = dialogs.filter(d => d.isChannel);
    console.log("\nChannels you can track:");
    channels.forEach(c => console.log(`${c.title} | ID: ${c.id}`));

})();
