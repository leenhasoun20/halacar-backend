import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Replicate from "replicate";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

app.get("/", (req, res) => {
  res.send("Hala Car AI Backend is running");
});

// ─────────────────────────────────────────────
// POST /chat  —  Chatbot (Groq - Free)
// ─────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: "No message provided" });
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
      ...history.slice(-10).map(m => ({
        role: m.role === 'bot' ? 'assistant' : 'user',
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages,
        max_tokens: 512,
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    console.log("Groq response:", JSON.stringify(data));

    if (data.error) {
      return res.status(500).json({ success: false, error: data.error.message });
    }

    const reply = data.choices?.[0]?.message?.content || "عذراً، حاول مرة ثانية.";
    res.json({ success: true, reply });

  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ success: false, error: "Chat failed", details: error.message });
  }
});

// ─────────────────────────────────────────────
// POST /generate-preview  —  AI wheel preview
// ─────────────────────────────────────────────
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

    let prompt;
    let model;
    let input;

    if (useCamera && carImageBase64) {
      prompt = `Edit this car photo. The ONLY edit needed: replace the tire rims (the metal alloy wheel/rim part, not the rubber tire) with ${
        wheelDescription || "modern luxury alloy rims"
      }. The new rims must be clearly visible and noticeably different from the original. Keep the rubber tire, car body, color, background, and everything else identical. Photorealistic, high quality.`;

      model = "black-forest-labs/flux-kontext-max";
      input = {
        prompt,
        input_image: carImageBase64,
        aspect_ratio: "match_input_image",
        output_format: "jpg",
        output_quality: 95,
        prompt_upsampling: true,
      };

      console.log("Mode: Camera (flux-kontext-max)");

    } else if (wheelImageUrl) {
      prompt = `Generate a photorealistic ${
        carModel || "luxury sedan car"
      }, ${carAngle || "side view, profile shot"}.
IMPORTANT: The alloy wheel rims must look EXACTLY like the rim in the reference image.
Copy the exact spoke design, number of spokes, rim color, finish (matte/gloss/chrome), and center cap.
Do not simplify or change the rim design in any way.
Studio showroom photography, black background, 8k, ultra realistic, highly detailed rims.`;

      model = "black-forest-labs/flux-kontext-max";
      input = {
        prompt,
        input_image: wheelImageUrl,
        aspect_ratio: "16:9",
        output_format: "jpg",
        output_quality: 95,
        prompt_upsampling: true,
      };

      console.log("Mode: Wheel Reference (flux-kontext-max)");

    } else {
      prompt = `A ${carModel || "luxury sedan car"}, ${
        carAngle || "side view, profile shot"
      }, with ${
        wheelDescription || "modern premium alloy rims"
      }, studio showroom photography, dramatic lighting, black background, ultra realistic, 8k, cinematic, professional automotive photography, highly detailed alloy rims, clean reflections`;

      model = "black-forest-labs/flux-1.1-pro";
      input = {
        prompt,
        width: 1024,
        height: 576,
        num_inference_steps: 28,
        guidance: 3.5,
        output_format: "jpg",
        output_quality: 95,
      };

      console.log("Mode: Text Only (flux-1.1-pro)");
    }

    console.log("Model:", model);
    console.log("Prompt:", prompt);

    const output = await replicate.run(model, { input });

    console.log("Output type:", typeof output);
    console.log("Output:", output);

    let imageUrl;

    if (typeof output === "string") {
      imageUrl = output;
    } else if (Array.isArray(output)) {
      const item = output[0];
      if (typeof item === "string") {
        imageUrl = item;
      } else if (item && typeof item.url === "function") {
        imageUrl = item.url().href;
      } else {
        imageUrl = String(item);
      }
    } else if (output && typeof output.url === "function") {
      imageUrl = output.url().href;
    } else if (output && typeof output === "object") {
      if (output.url && typeof output.url === "function") {
        imageUrl = output.url().href;
      } else if (output.url && typeof output.url === "string") {
        imageUrl = output.url;
      } else {
        imageUrl = String(output);
      }
    } else {
      imageUrl = String(output);
    }

    console.log("Final imageUrl:", imageUrl);

    if (!imageUrl || imageUrl === "undefined" || imageUrl === "[object Object]") {
      return res.status(500).json({
        success: false,
        error: "Could not extract image URL",
        rawOutput: String(output),
      });
    }

    res.json({ success: true, imageUrl });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate preview",
      details: error.message,
    });
  }
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Hala Car AI Backend running on http://localhost:${PORT}`);
});