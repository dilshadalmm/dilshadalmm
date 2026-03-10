import express from "express";
import cors from "cors";

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

    // Dummy response in the exact structure the frontend expects
    const dummyResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Hello! This is a test response from your proxy. You can now see messages in the chat."
              }
            ]
          }
        }
      ]
    };

    // Simulate a small delay like a real API
    await new Promise(resolve => setTimeout(resolve, 500));

    res.json(dummyResponse);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gemini proxy running on port ${PORT}`));
