import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase Admin connected');
} catch (e) {
  console.error('❌ Firebase Admin init failed:', e.message);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("Hala Car AI Backend is running ✅"));

async function sendExpoPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { sent: 0 };
  const validTokens = tokens.filter(t => t && t.startsWith('ExponentPushToken'));
  const messages = validTokens.map(token => ({
    to: token, sound: 'default', title, body, data,
    android: { channelId: 'default' }, priority: 'high',
  }));
  const chunks = [];
  for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));
  let totalSent = 0;
  for (const chunk of chunks) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const result = await res.json();
      totalSent += chunk.length;
      console.log(`Push sent: ${chunk.length}`, result?.data?.slice(0, 2));
    } catch (e) { console.error('Push send error:', e.message); }
  }
  return { sent: totalSent };
}

async function saveNotification({ userId, title, body, type, screen, screenParams }) {
  try {
    await db.collection('notifications').add({
      userId: userId || 'all', title, body: body || '',
      type: type || 'general', screen: screen || null,
      screenParams: screenParams || null, read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.error('saveNotification error:', e.message); }
}

app.post("/notify/new-product", async (req, res) => {
  try {
    const { productId, productName, category, targetBrands = [] } = req.body;
    if (!productName) return res.status(400).json({ success: false, error: 'productName required' });
    const snapshot = await db.collection('users').where('expoPushToken', '!=', null).get();
    const tokens = [], userIds = [];
    snapshot.forEach(docSnap => {
      const user = docSnap.data();
      if (!user.expoPushToken) return;
      if (targetBrands.length > 0) {
        const userCar = (user.car || '').toLowerCase();
        const userCar2 = (user.secondCar || '').toLowerCase();
        const match = targetBrands.some(b => userCar.includes(b.toLowerCase()) || userCar2.includes(b.toLowerCase()));
        if (!match) return;
      }
      tokens.push(user.expoPushToken);
      userIds.push(docSnap.id);
    });
    const title = `🆕 New ${category || 'Product'} Available!`;
    const body = productName;
    const result = await sendExpoPush(tokens, title, body, { screen: 'ProductDetail', productId });
    await Promise.all(userIds.map(uid =>
      saveNotification({ userId: uid, title, body, type: 'product', screen: 'ProductDetail', screenParams: { productId } })
    ));
    res.json({ success: true, ...result, matched: tokens.length });
  } catch (e) {
    console.error('/notify/new-product error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/notify/service-status", async (req, res) => {
  try {
    const { requestId, userId, status, serviceTitle } = req.body;
    if (!userId || !status) return res.status(400).json({ success: false, error: 'userId and status required' });
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, error: 'User not found' });
    const token = userDoc.data().expoPushToken;
    const statusMessages = {
      confirmed:   { title: '✅ Booking Confirmed!',     body: `Your ${serviceTitle || 'service'} has been confirmed.` },
      accepted:    { title: '✅ Request Accepted!',       body: `A technician has been assigned to your ${serviceTitle || 'service'}.` },
      in_progress: { title: '🚗 Technician On The Way!', body: 'Your technician is heading to you now.' },
      done:        { title: '✓ Service Completed!',      body: `Your ${serviceTitle || 'service'} is done. Rate your experience!` },
      cancelled:   { title: '❌ Booking Cancelled',      body: `Your ${serviceTitle || 'service'} request was cancelled.` },
    };
    const msg = statusMessages[status];
    if (!msg) return res.json({ success: true, sent: 0, reason: 'No message for this status' });
    let result = { sent: 0 };
    if (token) result = await sendExpoPush([token], msg.title, msg.body, { screen: 'OrderTracking', requestId });
    await saveNotification({ userId, title: msg.title, body: msg.body, type: 'service', screen: 'OrderTracking', screenParams: { requestId } });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('/notify/service-status error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/notify/ad", async (req, res) => {
  try {
    const { adId, adTitle, adDescription } = req.body;
    if (!adTitle) return res.status(400).json({ success: false, error: 'adTitle required' });
    const snapshot = await db.collection('users').where('expoPushToken', '!=', null).get();
    const tokens = [];
    snapshot.forEach(doc => { const token = doc.data().expoPushToken; if (token) tokens.push(token); });
    const title = `🎉 ${adTitle}`;
    const body = adDescription || 'Check out our latest offer!';
    const result = await sendExpoPush(tokens, title, body, { screen: 'AdDetail', adId });
    await saveNotification({ userId: 'all', title, body, type: 'ad', screen: 'AdDetail', screenParams: { adId } });
    res.json({ success: true, ...result, total: tokens.length });
  } catch (e) {
    console.error('/notify/ad error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ success: false, error: "No message provided" });
    const messages = [
      {
        role: "system",
        content: `أنت مساعد ذكي لمتجر HalaCar المتخصص في بيع الجنوط والإطارات وإكسسوارات السيارات في فلسطين.
مهمتك مساعدة العملاء في:
- اختيار الجنط المناسب لسيارتهم
- اختيار الإطارات المناسبة
- الإجابة عن أسئلة الصيانة والتركيب
- شرح الفرق بين المنتجات والمواصفات التقنية
قواعد: رد دائماً بالعربية بأسلوب ودي ومختصر. معلومات التواصل: هاتف +970595100676، إيميل halacar-1@hotmail.com`,
      },
      ...history.slice(-10).map(m => ({ role: m.role === "bot" ? "assistant" : "user", content: m.content })),
      { role: "user", content: message },
    ];
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", messages, max_tokens: 512, temperature: 0.7 }),
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ success: false, error: data.error.message });
    res.json({ success: true, reply: data.choices?.[0]?.message?.content || "عذراً، حاول مرة ثانية." });
  } catch (error) {
    res.status(500).json({ success: false, error: "Chat failed", details: error.message });
  }
});

async function urlToBuffer(url) {
  const r = await fetch(url);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

app.post("/generate-preview", async (req, res) => {
  try {
    const { wheelDescription, carModel, carAngle, wheelImageUrl, carImageBase64, useCamera } = req.body;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    console.log(`🎨 generate-preview | useCamera:${useCamera} | hasWheelImg:${!!wheelImageUrl} | hasCarImg:${!!carImageBase64}`);

    let detailedWheelDesc = wheelDescription || "modern premium alloy wheel rim";

    if (wheelImageUrl && !useCamera) {
      try {
        const visionRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o",
            max_tokens: 200,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: wheelImageUrl } },
                { type: "text", text: `Analyze this alloy wheel image precisely. Describe:
1. SPOKES: exact count, shape (straight/Y-split/mesh/turbine/multi-spoke), thickness
2. FINISH: color (jet-black/anthracite/gunmetal/silver/chrome/bronze/two-tone), surface (matte/gloss/brushed/polished/diamond-cut machined face)
3. RIM LIP: color
4. OVERALL STYLE: sporty/luxury/aggressive/classic
Output ONLY the description, 70 words max.` },
              ],
            }],
          }),
        });
        const visionData = await visionRes.json();
        if (visionData.choices?.[0]?.message?.content) {
          detailedWheelDesc = visionData.choices[0].message.content;
        }
      } catch (e) { console.log("⚠️ Vision failed:", e.message); }
    }

    let imageUrl;

    if (useCamera && carImageBase64) {
      const base64Data = carImageBase64.replace(/^data:image\/\w+;base64,/, "");
      const carBuffer = Buffer.from(base64Data, "base64");
      const formData = new FormData();
      formData.append("model", "gpt-image-1");
      formData.append("prompt",
        `Edit this car photo: replace ONLY the metal alloy wheel rims (spokes and center) with: ${detailedWheelDesc}. ` +
        `Keep everything else 100% identical: rubber tires, car body color, background, lighting, shadows. ` +
        `Only the rim spoke design changes. Photorealistic result, looks like a real photo.`
      );
      formData.append("size", "1536x1024");
      formData.append("quality", "high");
      formData.append("image", new Blob([carBuffer], { type: "image/jpeg" }), "car.jpg");
      const editRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
        body: formData,
      });
      const editData = await editRes.json();
      if (editData.data?.[0]?.url) imageUrl = editData.data[0].url;
      else if (editData.data?.[0]?.b64_json) imageUrl = `data:image/png;base64,${editData.data[0].b64_json}`;
      else throw new Error(editData.error?.message || "Camera edit failed");
    }

    else if (wheelImageUrl) {
      const wheelBuffer = await urlToBuffer(wheelImageUrl);
      const formData = new FormData();
      formData.append("model", "gpt-image-1");
      formData.append("prompt",
        `Professional automotive showroom photo of a ${carModel || "modern luxury sedan"} ` +
        `from the ${carAngle || "side profile"} angle. ` +
        `Pure black studio background, dramatic cinematic rim lighting. ` +
        `The car has aftermarket alloy wheels: ${detailedWheelDesc}. ` +
        `Wheels are large, prominent, ultra-sharp — they are the focal point. ` +
        `Photorealistic, 8K quality, professional car advertisement style.`
      );
      formData.append("size", "1536x1024");
      formData.append("quality", "high");
      formData.append("image", new Blob([wheelBuffer], { type: "image/jpeg" }), "wheel.jpg");
      const genRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
        body: formData,
      });
      const genData = await genRes.json();
      if (genData.data?.[0]?.url) imageUrl = genData.data[0].url;
      else if (genData.data?.[0]?.b64_json) imageUrl = `data:image/png;base64,${genData.data[0].b64_json}`;
      else throw new Error(genData.error?.message || "Wheel reference generation failed");
    }

    else {
      const prompt =
        `Ultra-realistic professional automotive showroom photograph. ` +
        `A ${carModel || "modern luxury sedan"} shot from the ${carAngle || "side profile"}, ` +
        `pure black studio background, dramatic cinematic lighting with bright rim highlights and subtle reflections on the car body. ` +
        `The car is fitted with premium aftermarket alloy wheels: ${detailedWheelDesc}. ` +
        `The wheels are the main focal point — large, crystal-clear, every spoke and machined surface detail is razor sharp. ` +
        `Professional car advertisement photography, photorealistic, hyperdetailed.`;
      const genRes = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: "dall-e-3", prompt, size: "1792x1024", quality: "hd", style: "natural", n: 1 }),
      });
      const genData = await genRes.json();
      if (genData.data?.[0]?.url) imageUrl = genData.data[0].url;
      else throw new Error(genData.error?.message || "dall-e-3 generation failed");
    }

    res.json({ success: true, imageUrl });

  } catch (error) {
    console.error("❌ generate-preview error:", error);
    res.status(500).json({ success: false, error: "Failed to generate preview", details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Hala Car Backend running on port ${PORT}`);
});
