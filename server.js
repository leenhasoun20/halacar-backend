import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import sharp from "sharp";

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

app.get("/", (req, res) => {
  res.send("Hala Car AI Backend is running ✅");
});

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
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(chunk),
      });

      const result = await response.json();
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

    snapshot.forEach((docSnap) => {
      const token = docSnap.data().expoPushToken;
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
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

function normalizeBase64Image(base64Image) {
  if (!base64Image) return null;
  return base64Image.replace(/^data:image\/\w+;base64,/, "");
}

function distancePixels(a, b, width, height) {
  const ax = a.x * width;
  const ay = a.y * height;
  const bx = b.x * width;
  const by = b.y * height;

  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

function makeWheelMaskSvg(size) {
  const r = size / 2;
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${r}" cy="${r}" r="${r * 0.495}" fill="white"/>
    </svg>
  `);
}

function makeShadowSvg(size) {
  const r = size / 2;
  return Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="blur">
          <feGaussianBlur stdDeviation="${Math.max(2, size * 0.025)}"/>
        </filter>
      </defs>
      <ellipse
        cx="${r}"
        cy="${r * 1.03}"
        rx="${r * 0.47}"
        ry="${r * 0.45}"
        fill="rgba(0,0,0,0.33)"
        filter="url(#blur)"
      />
    </svg>
  `);
}

async function removeSimpleBackgroundAndCircleWheel(wheelBuffer, size) {
  const raw = await sharp(wheelBuffer)
    .rotate()
    .resize(size, size, {
      fit: "cover",
      position: "center",
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const data = raw.data;
  const channels = raw.info.channels;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const aIndex = i + 3;

    const isWhiteBg = r > 232 && g > 232 && b > 232;
    const isAlmostWhite = r > 245 && g > 245 && b > 245;
    const isVeryLightGray = r > 225 && g > 225 && b > 225 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8;

    if (isWhiteBg || isAlmostWhite || isVeryLightGray) {
      data[aIndex] = 0;
    }
  }

  const cleaned = await sharp(data, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels,
    },
  })
    .png()
    .toBuffer();

  const mask = makeWheelMaskSvg(size);

  return sharp(cleaned)
    .composite([
      {
        input: mask,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
}

function buildWheelTargets(wheelFit, imageWidth, imageHeight) {
  const targets = [];

  if (wheelFit?.front?.center && wheelFit?.front?.edge) {
    const radius = distancePixels(
      wheelFit.front.center,
      wheelFit.front.edge,
      imageWidth,
      imageHeight
    );

    targets.push({
      name: "front",
      cx: wheelFit.front.center.x * imageWidth,
      cy: wheelFit.front.center.y * imageHeight,
      radius,
    });
  }

  if (wheelFit?.rear?.center && wheelFit?.rear?.edge) {
    const radius = distancePixels(
      wheelFit.rear.center,
      wheelFit.rear.edge,
      imageWidth,
      imageHeight
    );

    targets.push({
      name: "rear",
      cx: wheelFit.rear.center.x * imageWidth,
      cy: wheelFit.rear.center.y * imageHeight,
      radius,
    });
  }

  return targets.filter((t) => t.radius > 8);
}

async function generateGeometricWheelPreview({
  carImageBase64,
  wheelImageUrl,
  wheelFit,
}) {
  if (!carImageBase64) {
    throw new Error("carImageBase64 is required");
  }

  if (!wheelImageUrl) {
    throw new Error("wheelImageUrl is required for geometric wheel fitting");
  }

  if (!wheelFit?.front || !wheelFit?.rear) {
    throw new Error("wheelFit points are required");
  }

  const carBuffer = Buffer.from(normalizeBase64Image(carImageBase64), "base64");
  const wheelBuffer = await urlToBuffer(wheelImageUrl);

  const preparedCarBuffer = await sharp(carBuffer)
    .rotate()
    .resize({
      width: 1600,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const carMeta = await sharp(preparedCarBuffer).metadata();
  const imageWidth = carMeta.width;
  const imageHeight = carMeta.height;

  const targets = buildWheelTargets(wheelFit, imageWidth, imageHeight);

  if (targets.length === 0) {
    throw new Error("No valid wheel targets found");
  }

  const composites = [];

  for (const target of targets) {
    const rimRadius = Math.max(10, Math.round(target.radius * 0.92));
    const size = Math.max(24, rimRadius * 2);

    const wheelPng = await removeSimpleBackgroundAndCircleWheel(wheelBuffer, size);
    const shadow = makeShadowSvg(size);

    const left = Math.round(target.cx - size / 2);
    const top = Math.round(target.cy - size / 2);

    composites.push({
      input: shadow,
      left,
      top,
      blend: "over",
    });

    composites.push({
      input: wheelPng,
      left,
      top,
      blend: "over",
    });
  }

  const outputBuffer = await sharp(preparedCarBuffer)
    .composite(composites)
    .jpeg({
      quality: 94,
      mozjpeg: true,
    })
    .toBuffer();

  return {
    imageUrl: `data:image/jpeg;base64,${outputBuffer.toString("base64")}`,
    providerMode: "geometric_wheel_fit",
  };
}

async function analyzeWheelImage({ wheelImageUrl, wheelDescription, openaiKey }) {
  let detailedWheelDesc = wheelDescription || "modern premium alloy wheel rim";

  if (!wheelImageUrl || !openaiKey) return detailedWheelDesc;

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

async function openAIGenerateCarFromSpecsFallback({
  openaiKey,
  wheelImageUrl,
  detailedWheelDesc,
  carModel,
  carAngle,
}) {
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is missing for AI Generate fallback");
  }

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
          providerMode: "openai_spec_generation_with_wheel_reference",
        };
      }

      if (genData.data?.[0]?.b64_json) {
        return {
          imageUrl: `data:image/png;base64,${genData.data[0].b64_json}`,
          providerMode: "openai_spec_generation_with_wheel_reference",
        };
      }

      console.log("⚠️ OpenAI wheel reference generation failed:", genData.error?.message || genData);
    } catch (e) {
      console.log("⚠️ OpenAI wheel reference generation exception:", e.message);
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
      providerMode: "openai_spec_generation_description_only",
    };
  }

  throw new Error(genData.error?.message || "OpenAI DALL-E generation failed");
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
      wheelFit,
    } = req.body;

    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    console.log(
      `🎨 generate-preview | useCamera:${!!useCamera} | hasWheelImg:${!!wheelImageUrl} | hasCarImg:${!!carImageBase64} | hasWheelFit:${!!wheelFit}`
    );

    if (useCamera && carImageBase64) {
      const result = await generateGeometricWheelPreview({
        carImageBase64,
        wheelImageUrl,
        wheelFit,
      });

      return res.json({
        success: true,
        imageUrl: result.imageUrl,
        meta: {
          provider: "geometric",
          mode: result.providerMode,
          hasWheelImage: !!wheelImageUrl,
          hasCarImage: !!carImageBase64,
          hasWheelFit: !!wheelFit,
        },
      });
    }

    const detailedWheelDesc = await analyzeWheelImage({
      wheelImageUrl,
      wheelDescription,
      openaiKey: OPENAI_KEY,
    });

    const result = await openAIGenerateCarFromSpecsFallback({
      openaiKey: OPENAI_KEY,
      wheelImageUrl,
      detailedWheelDesc,
      carModel,
      carAngle,
    });

    return res.json({
      success: true,
      imageUrl: result.imageUrl,
      meta: {
        provider: "openai_spec_fallback",
        mode: result.providerMode,
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
