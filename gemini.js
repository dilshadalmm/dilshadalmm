import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-3-haiku-20240307"; // fast & cheap; change if you prefer
const ANTHROPIC_VERSION = "2023-06-01"; // required header

// Retry helper for rate limits (429) and network errors
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        console.log(`Rate limited. Retrying in ${delay}ms (attempt ${i+1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return response; // success or other error (will be handled later)
    } catch (err) {
      const delay = Math.pow(2, i) * 1000;
      console.log(`Network error. Retrying in ${delay}ms (attempt ${i+1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Max retries exceeded");
}

app.get("/", (req, res) => {
  res.send("Dilshad Claude Proxy is live. Use POST /gemini for requests.");
});

app.post("/gemini", async (req, res) => {
  try {
    if (!CLAUDE_API_KEY) {
      throw new Error("CLAUDE_API_KEY environment variable not set");
    }

    // Extract the user message from the frontend's payload
    const { contents } = req.body;
    const userMessage = contents?.[0]?.parts?.[0]?.text || "";

    // Claude expects a messages array (system prompt can be separate, but we'll include it in the user message for simplicity)
    // The frontend already includes the system prompt in the user message, so we send it as-is.
    const requestBody = {
      model: CLAUDE_MODEL,
      max_tokens: 1024,      // adjust as needed
      messages: [
        { role: "user", content: userMessage }
      ]
    };

    const response = await fetchWithRetry(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "Claude API error"
      });
    }

    // Claude returns content in data.content[0].text
    const claudeText = data.content?.[0]?.text || "⚠️ No response from Claude.";

    // Transform to the format your frontend expects
    res.json({
      candidates: [
        {
          content: {
            parts: [
              { text: claudeText }
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
app.listen(PORT, () => console.log(`Claude proxy running on port ${PORT}`));
