require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const ai = require('./services/ai');
const path = require('path');
const { getSession, updateSession } = require('./services/state');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function sanitizeInput(text) {
  if (!text) return '';
  return text.trim().replace(/[.,!?;:]+$/, '');
}

app.post('/api/call', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });
  try {
    const isLocal = req.get('host').includes('localhost');
    const protocol = isLocal ? 'http' : 'https';
    const voiceUrl = `${protocol}://${req.get('host')}/voice`;
    const call = await twilioClient.calls.create({ url: voiceUrl, to: phoneNumber, from: process.env.TWILIO_PHONE_NUMBER });
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ numDigits: 1, action: '/voice/handle-language', method: 'POST', timeout: 5 });
  gather.say("For English, press 1. For Thai, press 2.");
  twiml.redirect('/voice');
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/handle-language', async (req, res) => {
  const digits = req.body.Digits;
  const callerId = req.body.Direction === 'outbound-api' ? req.body.To : req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();
  let language = digits === '2' ? 'thai' : 'english';
  await updateSession(callerId, { language });
  const gather = twiml.gather({ numDigits: 1, action: '/voice/handle-selection', method: 'POST', timeout: 5 });
  const msg = language === 'english' ? "Welcome. Press 1 for quick query, 2 for detailed plan." : "ยินดีต้อนรับค่ะ กด 1 สำหรับคำถามด่วน กด 2 สำหรับแผนละเอียดค่ะ";
  gather.say(msg);
  twiml.redirect('/voice/handle-language?Digits=' + digits);
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/handle-selection', async (req, res) => {
  const digits = req.body.Digits;
  const callerId = req.body.Direction === 'outbound-api' ? req.body.To : req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();
  const session = await getSession(callerId);
  const lang = session.language || 'english';
  if (digits === '1') {
    await updateSession(callerId, { mode: 'quick' });
    const gather = twiml.gather({ input: 'speech', action: '/voice/quick-query', timeout: 3, speechTimeout: 'auto' });
    gather.say(lang === 'english' ? "Please tell me your question." : "กรุณาแจ้งคำถามของคุณค่ะ");
    twiml.redirect('/voice/handle-selection?Digits=1');
  } else if (digits === '2') {
    await updateSession(callerId, { mode: 'detailed' });
    const gather = twiml.gather({ input: 'speech', action: '/voice/full-assistance', timeout: 5, speechTimeout: 'auto' });
    gather.say(lang === 'english' ? "Great. Please tell me your name." : "รบกวนแจ้งชื่อของคุณด้วยค่ะ");
    twiml.redirect('/voice/full-assistance');
  } else { twiml.redirect('/voice'); }
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/quick-query', async (req, res) => {
  const userQuery = req.body.SpeechResult || '';
  const callerId = req.body.Direction === 'outbound-api' ? req.body.To : req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();
  const session = await getSession(callerId);
  if (!userQuery) {
    twiml.say(session.language === 'thai' ? "ไม่ได้ยินเสียงค่ะ กด 2 สำหรับแผนละเอียดค่ะ" : "No speech heard. Press 2 for plan.");
  } else {
    const aiResponse = await ai.getQuickResponse(userQuery, session.language);
    const gather = twiml.gather({ numDigits: 1, action: '/voice/handle-selection', timeout: 3 });
    gather.say(aiResponse);
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/full-assistance', async (req, res) => {
  const callerId = req.body.Direction === 'outbound-api' ? req.body.To : req.body.From;
  const userInput = req.body.SpeechResult || 'Hello';
  const twiml = new twilio.twiml.VoiceResponse();
  const session = await getSession(callerId);
  const aiResponse = await ai.getDynamicVoiceResponse(sanitizeInput(userInput), session.voiceHistory, session.language);
  session.voiceHistory.push({ role: 'user', parts: [{ text: userInput }] });
  session.voiceHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
  if (session.voiceHistory.length > 20) session.voiceHistory.splice(0, 2);
  await updateSession(callerId, session);
  const isDispatch = aiResponse.includes("DISPATCH_WHATSAPP");
  const isFinal = aiResponse.includes("TERMINATE_CALL");
  let cleanResponse = aiResponse.replace("DISPATCH_WHATSAPP", "").replace("TERMINATE_CALL", "").trim();
  if (isDispatch) {
    const formData = await ai.extractFarmerData(session.voiceHistory);
    generateAndSendWhatsApp(callerId, formData, session.language);
  }
  if (isFinal) {
    twiml.say(cleanResponse); twiml.hangup();
    await updateSession(callerId, { voiceHistory: [] });
  } else {
    const gather = twiml.gather({ input: 'speech', action: '/voice/full-assistance', timeout: 5, speechTimeout: 'auto' });
    gather.say(cleanResponse); twiml.redirect('/voice/full-assistance');
  }
  res.type('text/xml').send(twiml.toString());
});

app.get('/api/plan-pdf', async (req, res) => {
  const { name, location, region, climate, targetCrop, pastCrop, soilType, terrain, language } = req.query;
  try {
    const detailedPlan = await ai.generateDetailedPlan({ name, location, region, climate, targetCrop, pastCrop, soilType, terrain }, language);
    const pdfBuffer = await ai.generatePdfBuffer(detailedPlan, { name, location, targetCrop, soilType, terrain });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=AgriSpark_Plan.pdf`);
    res.send(pdfBuffer);
  } catch (error) { res.status(500).send("Error generating PDF."); }
});

app.get('/api/detailed-manual', async (req, res) => {
  const { name, location, region, climate, targetCrop, pastCrop, soilType, terrain, language } = req.query;
  const detailedPlan = await ai.generateDetailedPlan({ name, location, region, climate, targetCrop, pastCrop, soilType, terrain }, language);
  res.json({ plan: detailedPlan });
});

app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  const senderNumber = req.body.From; 
  const mediaUrl = req.body.MediaUrl0;
  const twiml = new twilio.twiml.MessagingResponse();
  const session = await getSession(senderNumber);
  if (incomingMsg.trim() || mediaUrl) {
    const aiReply = await ai.getWhatsAppChatResponse(incomingMsg, session.whatsappHistory, mediaUrl, session.language);
    if (aiReply.includes("DISPATCH_WHATSAPP")) {
      const formData = await ai.extractFarmerData(session.whatsappHistory);
      generateAndSendWhatsApp(senderNumber, formData, session.language);
    }
    session.whatsappHistory.push({ role: 'user', parts: [{ text: incomingMsg }] });
    session.whatsappHistory.push({ role: 'model', parts: [{ text: aiReply }] });
    if (session.whatsappHistory.length > 10) session.whatsappHistory.splice(0, 2);
    await updateSession(senderNumber, { whatsappHistory: session.whatsappHistory });
    twiml.message(aiReply.replace("DISPATCH_WHATSAPP", "").trim());
  }
  res.type('text/xml').send(twiml.toString());
});

async function generateAndSendWhatsApp(toPhone, formData, language = 'english') {
  try {
    const summaryPlan = await ai.generateFullPlan(formData, language);
    const smsBody = (language === 'thai' ? "สรุปแผน: " : "Plan Summary: ") + summaryPlan.split('\n')[0];
    await twilioClient.messages.create({ body: smsBody, from: process.env.TWILIO_PHONE_NUMBER, to: toPhone.replace('whatsapp:', '') });
    const isLocal = !process.env.VERCEL;
    const host = process.env.VERCEL_URL || (isLocal ? 'localhost:3000' : 'agrispark.vercel.app');
    const pdfLink = `${isLocal ? 'http' : 'https'}://${host}/api/plan-pdf?${new URLSearchParams({...formData, language}).toString()}`;
    await twilioClient.messages.create({ body: summaryPlan + "\n\nPlan PDF attached below.", mediaUrl: [pdfLink], from: process.env.TWILIO_WHATSAPP_NUMBER, to: toPhone.startsWith('whatsapp:') ? toPhone : `whatsapp:${toPhone}` });
  } catch (error) { console.error("Dispatch Error:", error.message); }
}

if (!process.env.VERCEL) app.listen(port, () => console.log(`AgriSpark listening on port ${port}`));
module.exports = app;
