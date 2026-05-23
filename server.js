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
        "Authorization": `Bearer ${openaiKey}`,
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
                image_url: { url: wheelImageUrl },
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

  /*
    المحاولة الأولى:
    نرسل صورة السيارة + صورة الجنط كمرجع.
    لو الـ API قبل صورتين، النتيجة تكون أفضل.
  */
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
          "Authorization": `Bearer ${openaiKey}`,
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

  /*
    fallback:
    لو إرسال صورتين فشل، نرسل صورة السيارة فقط مع وصف دقيق للجنط.
  */
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
      "Authorization": `Bearer ${openaiKey}`,
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
  /*
    هذا الوضع لما المستخدم يختار مواصفات السيارة بدون تصوير.
    إذا عندنا صورة جنط، نرسلها كمرجع.
  */
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
          "Authorization": `Bearer ${openaiKey}`,
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

  /*
    fallback بدون صورة جنط.
  */
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
      "Authorization": `Bearer ${openaiKey}`,
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
