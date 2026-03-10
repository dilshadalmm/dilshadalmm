import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // Ensure Node 18+ or install node-fetch

const app = express();
app.use(cors());
app.use(express.json());

// Landing route (optional)
app.get("/", (req, res) => {
  res.send("Dilshad Gemini Proxy is live. Use POST /gemini for requests.");
});

// POST /gemini endpoint
app.post("/gemini", async (req, res) => {
  try {
    const { contents } = req.body;
    const userMessage = contents?.[0]?.parts?.[0]?.text || "";

    const systemPrompt = "You are Dilshad, a technical Middle School Teacher. Use English only. Keep responses concise. Use LaTeX for math (e.g., $x^2$). Format important content as follows: **important term** (highlighted), __definition__ (underlined), [[formula or equation]] (boxed). The user's request is top priority.";

    // Call Gemini API
    const geminiResponse = await fetch(
      "https://api.generativeai.google.com/v1beta2/models/text-bison-001:generate", 
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GEMINI_API_KEY}`
        },
        body: JSON.stringify({
          prompt: `${systemPrompt}\n\nUSER PROMPT: ${userMessage}`
        })
      }
    );

    const data = await geminiResponse.json();

    // Ensure frontend-compatible response
    const textResponse = data?.output_text || "⚠️ No response from Gemini.";

    res.json({
      candidates: [
        {
          content: {
            parts: [
              { text: textResponse }
            ]
          }
        }
      ]
    });

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gemini proxy running on port ${PORT}`));
