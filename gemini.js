import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// POST /gemini endpoint
app.post("/gemini", async (req, res) => {
  try {
    const { contents } = req.body; // expects frontend format

    const systemPrompt = "You are Dilshad, a technical Middle School Teacher. Use English only. Keep responses concise. Use LaTeX for math (e.g., $x^2$). Format important content as follows: **important term** (highlighted), __definition__ (underlined), [[formula or equation]] (boxed). The user's request is top priority.";

    // Merge system prompt with user message
    const payload = {
      contents: contents.map(item => ({
        role: item.role,
        parts: item.parts.map(part => ({
          text: `${systemPrompt}\n\nUSER PROMPT: ${part.text}`
        }))
      }))
    };

    // Replace with your actual Gemini API endpoint
    const geminiResponse = await fetch("https://api.gemini.com/v1/your-endpoint", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GEMINI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await geminiResponse.json();
    res.json(data);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gemini proxy running on port ${PORT}`));
