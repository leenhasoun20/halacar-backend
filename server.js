import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  console.log("✅ Firebase Admin connected");
} catch (e) {
  console.error("❌ Firebase Admin init failed:", e.message);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("Hala Car AI Backend is running ✅"));

async function sendExpoPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return { sent: 0 };

  const validTokens = tokens.filter((t) => t && t.startsWith("ExponentPushToken"));

  const messages = validTokens.map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
    data,
    android: { channelId: "default" },
    priority: "high",
  }));

  const chunks = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  let totalSent = 0;

  for (const chunk of chunks) {
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(chunk),
      });

      const result = await res.json();
      totalSent += chunk.length;
      console.log(`Push sent: ${chunk.length}`, result?.data?.slice(0, 2));
    } catch (e) {
      console.error("Push send error:", e.message);
    }
  }

  return { sent: totalSent };
}

async function saveNotification({ userId, title, body, type, screen, screenParams }) {
  try {
    if (!db) {
      console.log("⚠️ Firestore not connected, notification not saved");
      return;
    }

    await db.collection("notifications").add({
      userId: userId || "all",
      title,
      body: body || "",
      type: type || "general",
      screen: screen || null,
      screenParams: screenParams || null,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("saveNotification error:", e.message);
  }
}

app.post("/notify/new-product", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firestore is not connected",
      });
    }

    const { productId, productName, category, targetBrands = [] } = req.body;

    if (!productName) {
      return res.status(400).json({
        success: false,
        error: "productName required",
      });
    }

    const snapshot = await db.collection("users").where("expoPushToken", "!=", null).get();

    const tokens = [];
    const userIds = [];

    snapshot.forEach((docSnap) => {
      const user = docSnap.data();

      if (!user.expoPushToken) return;

      if (targetBrands.length > 0) {
        const userCar = (user.car || "").toLowerCase();
        const userCar2 = (user.secondCar || "").toLowerCase();

        const match = targetBrands.some(
          (b) =>
            userCar.includes(b.toLowerCase()) ||
            userCar2.includes(b.toLowerCase())
        );

        if (!match) return;
      }

      tokens.push(user.expoPushToken);
      userIds.push(docSnap.id);
    });

    const title = `🆕 New ${category || "Product"} Available!`;
    const body = productName;

    const result = await sendExpoPush(tokens, title, body, {
      screen: "ProductDetail",
      productId,
    });

    await Promise.all(
      userIds.map((uid) =>
        saveNotification({
          userId: uid,
          title,
          body,
          type: "product",
          screen: "ProductDetail",
          screenParams: { productId },
        })
      )
    );

    res.json({
      success: true,
      ...result,
      matched: tokens.length,
    });
  } catch (e) {
    console.error("/notify/new-product error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.post("/notify/service-status", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firestore is not connected",
      });
    }

    const { requestId, userId, status, serviceTitle } = req.body;

    if (!userId || !status) {
      return res.status(400).json({
        success: false,
        error: "userId and status required",
      });
    }

    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const token = userDoc.data().expoPushToken;

    const statusMessages = {
      confirmed: {
        title: "✅ Booking Confirmed!",
        body: `Your ${serviceTitle || "service"} has been confirmed.`,
      },
      accepted: {
        title: "✅ Request Accepted!",
        body: `A technician has been assigned to your ${serviceTitle || "service"}.`,
      },
      in_progress: {
        title: "🚗 Technician On The Way!",
        body: "Your technician is heading to you now.",
      },
      done: {
        title: "✓ Service Completed!",
        body: `Your ${serviceTitle || "service"} is done. Rate your experience!`,
      },
      cancelled: {
        title: "❌ Booking Cancelled",
        body: `Your ${serviceTitle || "service"} request was cancelled.`,
      },
    };

    const msg = statusMessages[status];

    if (!msg) {
      return res.json({
        success: true,
        sent: 0,
        reason: "No message for this status",
      });
    }

    let result = { sent: 0 };

    if (token) {
      result = await sendExpoPush([token], msg.title, msg.body, {
        screen: "OrderTracking",
        requestId,
      });
    }

    await saveNotification({
      userId,
      title: msg.title,
      body: msg.body,
      type: "service",
      screen: "OrderTracking",
      screenParams: { requestId },
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (e) {
    console.error("/notify/service-status error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.post("/notify/ad", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error: "Firestore is not connected",
      });
    }

    const { adId, adTitle, adDescription } = req.body;

    if (!adTitle) {
      return res.status(400).json({
        success: false,
        error: "adTitle required",
      });
    }

    const snapshot = await db.collection("users").where("expoPushToken", "!=", null).get();

    const tokens = [];

    snapshot.forEach((doc) => {
      const token = doc.data().expoPushToken;
      if (token) tokens.push(token);
    });

    const title = `🎉 ${adTitle}`;
    const body = adDescription || "Check out our latest offer!";

    const result = await sendExpoPush(tokens, title, body, {
      screen: "AdDetail",
      adId,
    });

    await saveNotification({
      userId: "all",
      title,
      body,
      type: "ad",
      screen: "AdDetail",
      screenParams: { adId },
    });

    res.json({
      success: true,
      ...result,
      total: tokens.length,
    });
  } catch (e) {
    console.error("/notify/ad error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "No message provided",
      });
    }

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
      ...history.slice(-10).map((m) => ({
        role: m.role === "bot" ? "assistant" : "user",
        content: m.content,
      })),
      {
        role: "user",
        content: message,
      },
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages,
        max_tokens: 512,
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({
        success: false,
        error: data.error.message,
      });
    }

    res.json({
      success: true,
      reply: data.choices?.[0]?.message?.content || "عذراً، حاول مرة ثانية.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Chat failed",
      details: error.message,
    });
  }
});

async function urlToBuffer(url) {
  const r = await fetch(url);

  if (!r.ok) {
    throw new Error(`Failed to download image: ${r.status} ${r.statusText}`);
  }

  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

function normalizeBase64Image(base64Image) {
  if (!base64Image) return null;
  return base64Image.replace(/^data:image\/\w+;base64,/, "");
}

async function analyzeWheelImage({ wheelImageUrl, wheelDescription, openaiKey }) {
  let detailedWheelDesc = wheelDescription || "modern premium alloy wheel rim";

  if (!wheelImageUrl) return detailedWheelDesc;

  try {
    const visionRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 220,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: wheelImageUrl,
                },
              },
              {
                type: "text",
                text:
                  `Analyze this alloy wheel image precisely for a product preview system. Describe:
1. SPOKES: exact count, shape, thickness, split pattern, mesh/turbine/Y-spoke/multi-spoke
2. FINISH: exact color, matte/gloss/metallic/chrome/bronze/gunmetal/black/silver/two-tone
3. RIM LIP: shape and color
4. CENTER CAP: visible style and color
5. OVERALL STYLE: sporty/luxury/aggressive/classic

Important: describe the wheel so another image model can preserve the same design.
Output ONLY the description, max 90 words.`,
              },
            ],
          },
        ],
      }),
    });

    const visionData = await visionRes.json();

    if (visionData.error) {
      console.log("⚠️ Wheel vision API error:", visionData.error.message);
      return detailedWheelDesc;
    }

    if (visionData.choices?.[0]?.message?.content) {
      detailedWheelDesc = visionData.choices[0].message.content.trim();
    }
  } catch (e) {
    console.log("⚠️ Wheel vision failed:", e.message);
  }

  return detailedWheelDesc;
}

async function generateCameraPreview({
  openaiKey,
  carImageBase64,
  wheelImageUrl,
  detailedWheelDesc,
  carModel,
  carAngle,
}) {
  const base64Data = normalizeBase64Image(carImageBase64);
  const carBuffer = Buffer.from(base64Data, "base64");

  const prompt =
    `Edit this real car photo professionally for an automotive wheel preview app. ` +
    `Replace ONLY the visible metal alloy wheel rims with this wheel design: ${detailedWheelDesc}. ` +
    `Keep the original rubber tires, tire size, car body, car color, windows, background, lighting, shadows, reflections, and camera perspective unchanged. ` +
    `Do NOT redraw the full car. Do NOT change the car color. Do NOT change the background. ` +
    `Do NOT change the tire rubber. Only the metal rim/spoke/center-cap area should change. ` +
    `Fit the new rim perfectly inside the existing tire circles with correct perspective, realistic shadows, and natural lighting. ` +
    `The final image must look like a real product preview photo, not a drawing. ` +
    `Car context if useful: ${carModel || "unknown car"}, angle: ${carAngle || "side view"}.`;

  if (wheelImageUrl) {
    try {
      const wheelBuffer = await urlToBuffer(wheelImageUrl);

      const formData = new FormData();
      formData.append("model", "gpt-image-1");
      formData.append("prompt", prompt);
      formData.append("size", "1536x1024");
      formData.append("quality", "high");

      formData.append(
        "image",
        new Blob([carBuffer], { type: "image/jpeg" }),
        "car.jpg"
      );

      formData.append(
        "image",
        new Blob([wheelBuffer], { type: "image/jpeg" }),
        "wheel.jpg"
      );

      const editRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
        body: formData,
      });

      const editData = await editRes.json();

      if (editData.data?.[0]?.url) {
        return {
          imageUrl: editData.data[0].url,
          usedWheelReference: true,
          providerMode: "camera_edit_with_wheel_reference",
        };
      }

      if (editData.data?.[0]?.b64_json) {
        return {
          imageUrl: `data:image/png;base64,${editData.data[0].b64_json}`,
          usedWheelReference: true,
          providerMode: "camera_edit_with_wheel_reference",
        };
      }

      console.log("⚠️ Two-image edit failed:", editData.error?.message || editData);
    } catch (e) {
      console.log("⚠️ Two-image camera edit failed:", e.message);
    }
  }

  const fallbackFormData = new FormData();
  fallbackFormData.append("model", "gpt-image-1");
  fallbackFormData.append(
    "prompt",
    prompt +
      ` The wheel reference image could not be directly attached, so follow the wheel description very carefully.`
  );
  fallbackFormData.append("size", "1536x1024");
  fallbackFormData.append("quality", "high");
  fallbackFormData.append(
    "image",
    new Blob([carBuffer], { type: "image/jpeg" }),
    "car.jpg"
  );

  const fallbackRes = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
    },
    body: fallbackFormData,
  });

  const fallbackData = await fallbackRes.json();

  if (fallbackData.data?.[0]?.url) {
    return {
      imageUrl: fallbackData.data[0].url,
      usedWheelReference: false,
      providerMode: "camera_edit_description_only",
    };
  }

  if (fallbackData.data?.[0]?.b64_json) {
    return {
      imageUrl: `data:image/png;base64,${fallbackData.data[0].b64_json}`,
      usedWheelReference: false,
      providerMode: "camera_edit_description_only",
    };
  }

  throw new Error(fallbackData.error?.message || "Camera edit failed");
}

async function generateCarFromSpecsWithWheel({
  openaiKey,
  wheelImageUrl,
  detailedWheelDesc,
  carModel,
  carAngle,
}) {
  if (wheelImageUrl) {
    try {
      const wheelBuffer = await urlToBuffer(wheelImageUrl);

      const formData = new FormData();
      formData.append("model", "gpt-image-1");
      formData.append(
        "prompt",
        `Create a photorealistic automotive product preview image. ` +
          `Car: ${carModel || "modern car"}. ` +
          `Camera angle: ${carAngle || "side profile"}. ` +
          `Use a clean professional studio or showroom background. ` +
          `Fit the car with aftermarket alloy wheels matching this exact wheel reference: ${detailedWheelDesc}. ` +
          `The wheel design must be preserved as much as possible: spoke layout, color, finish, rim lip, and center cap. ` +
          `The wheels should be clearly visible, realistic, correctly scaled, and aligned with the car perspective. ` +
          `Do not make the result cartoonish. Do not distort the wheels. ` +
          `Final output should look like a real automotive advertisement photo.`
      );
      formData.append("size", "1536x1024");
      formData.append("quality", "high");
      formData.append(
        "image",
        new Blob([wheelBuffer], { type: "image/jpeg" }),
        "wheel.jpg"
      );

      const genRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
        body: formData,
      });

      const genData = await genRes.json();

      if (genData.data?.[0]?.url) {
        return {
          imageUrl: genData.data[0].url,
          usedWheelReference: true,
          providerMode: "spec_generation_with_wheel_reference",
        };
      }

      if (genData.data?.[0]?.b64_json) {
        return {
          imageUrl: `data:image/png;base64,${genData.data[0].b64_json}`,
          usedWheelReference: true,
          providerMode: "spec_generation_with_wheel_reference",
        };
      }

      console.log("⚠️ Wheel reference generation failed:", genData.error?.message || genData);
    } catch (e) {
      console.log("⚠️ Wheel reference generation exception:", e.message);
    }
  }

  const prompt =
    `Ultra-realistic professional automotive showroom photograph. ` +
    `A ${carModel || "modern luxury sedan"} shot from the ${carAngle || "side profile"}, ` +
    `clean premium studio background, dramatic cinematic lighting, realistic reflections on the car body. ` +
    `The car is fitted with premium aftermarket alloy wheels: ${detailedWheelDesc}. ` +
    `The wheels must be large, prominent, crystal-clear, and correctly aligned with the tires and perspective. ` +
    `Every spoke and machined surface detail should be sharp. ` +
    `Professional car advertisement photography, photorealistic, high detail, not cartoonish.`;

  const genRes = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      size: "1792x1024",
      quality: "hd",
      style: "natural",
      n: 1,
    }),
  });

  const genData = await genRes.json();

  if (genData.data?.[0]?.url) {
    return {
      imageUrl: genData.data[0].url,
      usedWheelReference: false,
      providerMode: "spec_generation_description_only",
    };
  }

  throw new Error(genData.error?.message || "dall-e-3 generation failed");
}

app.post("/generate-preview", async (req, res) => {
  try {
    const {
      wheelDescription,
      carModel,
      carAngle,
      wheelImageUrl,
      carImageBase64,
      useCamera,
    } = req.body;

    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_KEY) {
      return res.status(500).json({
        success: false,
        error: "OPENAI_API_KEY is missing on the server",
      });
    }

    console.log(
      `🎨 generate-preview | useCamera:${!!useCamera} | hasWheelImg:${!!wheelImageUrl} | hasCarImg:${!!carImageBase64}`
    );

    const detailedWheelDesc = await analyzeWheelImage({
      wheelImageUrl,
      wheelDescription,
      openaiKey: OPENAI_KEY,
    });

    let result;

    if (useCamera && carImageBase64) {
      result = await generateCameraPreview({
        openaiKey: OPENAI_KEY,
        carImageBase64,
        wheelImageUrl,
        detailedWheelDesc,
        carModel,
        carAngle,
      });
    } else {
      result = await generateCarFromSpecsWithWheel({
        openaiKey: OPENAI_KEY,
        wheelImageUrl,
        detailedWheelDesc,
        carModel,
        carAngle,
      });
    }

    res.json({
      success: true,
      imageUrl: result.imageUrl,
      meta: {
        provider: "openai",
        mode: result.providerMode,
        usedWheelReference: result.usedWheelReference,
        hasWheelImage: !!wheelImageUrl,
        hasCarImage: !!carImageBase64,
        carModel: carModel || null,
        carAngle: carAngle || null,
      },
    });
  } catch (error) {
    console.error("❌ generate-preview error:", error);

    res.status(500).json({
      success: false,
      error: "Failed to generate preview",
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Hala Car Backend running on port ${PORT}`);
});
