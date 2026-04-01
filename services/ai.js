const { GoogleGenAI } = require('@google/genai');
const PDFDocument = require('pdfkit');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const farmingAssistantSystemPrompt = `
You are a PhD-level Senior Agronomist for AgriSpark. Your behavior is structured, human-like, and highly conversational.

LANGUAGE RULES:
- Communicate ENTIRELY in the language specified (English or Thai).
- Maintain this language across voice, SMS, and WhatsApp.

STRICT 6-POINT DISCOVERY SEQUENCE (Detailed Plan):
1. **Name** (Identify the farmer)
2. **Location** (Establish region/district)
3. **Past Crop** (Rotation history)
4. **Target Crop** (Future goal)
5. **Soil Type** (Nutrient profile)
6. **Terrain** (Flat, hilly, irrigated, rain-fed, etc.)

CORE RULES:
- **MEMORY GUARD**: If a point is already known from history, DO NOT ask for it. Move to the next missing point.
- **SINGLE QUESTION turn**: Ask ONLY one question at a time.
- **HYPER-LOCAL ANALYSIS**: 
  - Normalize location text into Region and Climate type.
  - If location is vague, ask: "Can you specify nearest town or district?"
  - Adapt all advice (irrigation, crop selection, risk) to the local climate/weather inferred.
- **IMAGE ANALYSIS (WhatsApp)**:
  - Identify Crop type and Issue (disease, pest, dryness, nutrient deficiency).
  - Structure: Diagnosis, Treatment steps, Preventive measures.
  - If unclear: "Please send a closer or clearer image of the affected area."
- **ADVICE-FIRST**: Diagnose symptoms immediately (25 words max) before continuing the checklist.
- **DISPATCH**: Only after 6 points are confirmed, say: "DISPATCH_WHATSAPP" and inform the user.
- **EXIT**: Use "TERMINATE_CALL" only when the conversation is naturally finished.

FORMATTING:
- VOICE: Under 25 words, practical, non-robotic.
- WHATSAPP: Bold *Headers:*, bullets •, clear spacing.
`;

const modelName = 'gemini-3.1-flash-lite-preview';

async function getQuickResponse(userQuery, language = 'english') {
  try {
    const prompt = `
    LANGUAGE: ${language.toUpperCase()}
    THE USER IS ON A LIVE PHONE CALL.
    The farmer asked: "${userQuery}"
    
    Respond in ${language}:
    1. 1 highly specific, likely cause
    2. 2-3 immediate, actionable steps
    3. 1 prevention tip
    
    - Keep response under 30s speaking time.
    - END with: "Do you want detailed guidance? Press 2." (Translated to ${language})
    `;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: farmingAssistantSystemPrompt, temperature: 0.5 }
    });
    return response.text;
  } catch (error) {
    console.error("AI Quick Response Error:", error);
    return "Error processing request.";
  }
}

async function generateFullPlan(formData, language = 'english') {
  try {
    const prompt = `
    LANGUAGE: ${language.toUpperCase()}
    Produce a BRIEF, HIGH-LEVEL WhatsApp summary in ${language} (MAX 600 chars).
    Data:
    Farmer: ${formData.name} | Target: ${formData.targetCrop}
    Soil: ${formData.soilType} | Terrain: ${formData.terrain}
    
    Include:
    - Hyper-local Climate Insight
    - Main Actionable Advice
    - Risk Warning based on location
    `;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: farmingAssistantSystemPrompt, temperature: 0.7 }
    });
    return response.text;
  } catch (error) {
    console.error("AI Full Plan Error:", error);
    return "Error generating plan.";
  }
}

async function getDynamicVoiceResponse(userInput, history = [], language = 'english') {
  try {
    const prompt = `
    LANGUAGE: ${language.toUpperCase()}
    THE USER IS ON A LIVE PHONE CALL (IVR).
    Current Input: "${userInput}"
    
    RULES:
    1. Collect missing points (Name, Location, Past Crop, Target Crop, Soil, Terrain) one-by-one.
    2. If location is vague, ask for nearest town/district.
    3. If symptom provided, diagnose first, then proceed to next point.
    4. Keep response under 25 words in ${language}.
    `;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: farmingAssistantSystemPrompt, temperature: 0.6 }
    });
    return response.text;
  } catch (error) {
    console.error("AI Dynamic Voice Error:", error);
    return "Listening...";
  }
}

async function getMediaPart(url) {
  const axios = require('axios');
  const response = await axios.get(url, { 
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
  });
  return {
    inlineData: {
      data: Buffer.from(response.data).toString('base64'),
      mimeType: response.headers['content-type'] || 'image/jpeg'
    }
  };
}

async function getWhatsAppChatResponse(userText, history = [], imageUrl = null, language = 'english') {
  try {
    const contents = [...history];
    let promptContext = `
    LANGUAGE: ${language.toUpperCase()}
    THE USER IS ON WHATSAPP.
    IMAGE RULES:
    - If image present, follow structure: Diagnosis, Treatment, Prevention.
    - If blurry, ask for a better shot in ${language}.
    PLAN MODE: Only if requested, start 6-point collection.
    Q&A MODE: Provide expert, low-cost advice.
    User Message: "${userText}"
    `;
    const currentParts = [{ text: promptContext }];
    if (imageUrl) currentParts.push(await getMediaPart(imageUrl));
    contents.push({ role: 'user', parts: currentParts });

    const response = await ai.models.generateContent({
      model: modelName,
      contents: contents,
      config: { systemInstruction: farmingAssistantSystemPrompt, temperature: 0.7 }
    });
    return response.text;
  } catch (error) {
    console.error("WhatsApp AI Error:", error);
    return "Connection error.";
  }
}

async function generateDetailedPlan(formData, language = 'english') {
  try {
    const prompt = `
    LANGUAGE: ${language.toUpperCase()}
    Produce a 2000-word PhD manual in ${language}.
    Sections:
    1. Farmer Details (${formData.name}, ${formData.location})
    2. Field Analysis (Climate: ${formData.climate}, Region: ${formData.region})
    3. Crop Recommendation (Target: ${formData.targetCrop})
    4. Step-by-step Farming Plan
    5. Timeline (30-day Calendar)
    6. Risk Mitigation (Pests, Weather risks)
    `;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: farmingAssistantSystemPrompt, temperature: 0.8 }
    });
    return response.text;
  } catch (error) {
    console.error("AI Detailed Plan Error:", error);
    return "Error generating manual.";
  }
}

async function extractFarmerData(history) {
  try {
    const prompt = `Extract these 6 data points + inferred normalization as JSON:
    { "name": "...", "location": "...", "region": "...", "climate": "...", "pastCrop": "...", "targetCrop": "...", "soilType": "...", "terrain": "..." }
    Translate Thai region/climate to English in JSON.`;
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [...history, { role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0, responseMimeType: "application/json" }
    });
    return JSON.parse(response.text);
  } catch (e) {
    return { name: 'Unknown', location: 'Unknown' };
  }
}

async function generatePdfBuffer(planText, formData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      let buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
      doc.fillColor('#1a4d2e').fontSize(24).text('AgriSpark | Professional Manual', { align: 'center' });
      doc.moveDown();
      doc.fillColor('#000000').fontSize(11).text(planText, { align: 'justify', lineGap: 4, paragraphGap: 10 });
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = {
  getQuickResponse,
  generateFullPlan,
  getWhatsAppChatResponse,
  getDynamicVoiceResponse,
  generateDetailedPlan,
  extractFarmerData,
  generatePdfBuffer
};
