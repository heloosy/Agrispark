const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || process.env.STORAGE_URL, 
  socket: {
    reconnectStrategy: retries => Math.min(retries * 50, 500)
  }
});

client.on('error', err => console.error('Redis Client Error', err));

async function ensureConnection() {
  if (!client.isOpen) {
    try {
      await client.connect();
    } catch (err) {
      console.error("[Redis] Reconnect failed:", err.message);
    }
  }
}

async function getSession(phoneNumber) {
  try {
    await ensureConnection();
    
    let sessionData = await client.get(`session:${phoneNumber}`);
    let session = sessionData ? JSON.parse(sessionData) : null;
    
    if (!session) {
      session = {
        mode: null,
        language: 'english',
        step: null,
        data: { 
          name: null, 
          location: null, 
          pastCrop: null, 
          targetCrop: null, 
          soilType: null, 
          terrain: null 
        }, 
        whatsappHistory: [],
        voiceHistory: []
      };
    }
    
    return session;
  } catch (error) {
    console.error(`[Redis Error] Amnesia Prevention Active for ${phoneNumber}:`, error.message);
    return {
      mode: null,
      language: 'english',
      step: null,
      data: {},
      whatsappHistory: [],
      voiceHistory: []
    };
  }
}

async function updateSession(phoneNumber, updates) {
  try {
    await ensureConnection();
    
    const session = await getSession(phoneNumber);
    const updatedSession = Object.assign(session, updates);
    await client.set(`session:${phoneNumber}`, JSON.stringify(updatedSession));
    return updatedSession;
  } catch (error) {
    console.error(`[Redis] Update Error for ${phoneNumber}:`, error.message);
  }
}

async function clearSession(phoneNumber) {
  try {
    await ensureConnection();
    await client.del(`session:${phoneNumber}`);
  } catch (error) {
    console.error(`[Redis] Clear Error for ${phoneNumber}:`, error.message);
  }
}

const FULL_ASSIST_STEPS = ['name', 'location', 'pastCrop', 'targetCrop', 'soilType', 'terrain'];

module.exports = {
  getSession,
  updateSession,
  clearSession,
  FULL_ASSIST_STEPS
};
