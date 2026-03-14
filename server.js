const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");
const admin = require("firebase-admin");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

/* ---------------- Firebase ---------------- */

let firebaseInitialized = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseInitialized = true;
    console.log("✅ Firebase Admin initialized");
  }
} catch (err) {
  console.error("Firebase init error:", err.message);
}

const db = firebaseInitialized ? admin.firestore() : null;

/* ---------------- Gemini ---------------- */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ---------------- Pinecone ---------------- */

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

const index = pc.index(process.env.PINECONE_INDEX_NAME);

/* ---------------- Embedding ---------------- */

async function generateEmbedding(text) {
  if (!text || text.trim() === "") {
    throw new Error("Cannot embed empty text");
  }

  const model = genAI.getGenerativeModel({
    model: "text-embedding-004",
  });

  const result = await model.embedContent(text);

  return result.embedding.values;
}

/* ---------------- Question ID ---------------- */

function generateQuestionId() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString("hex");
  return `user-${timestamp}-${random}`;
}

/* ---------------- Image → Question ---------------- */

async function describeImage(base64Image) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: `
Extract ONLY the academic question from the image.

Rules:
- Do NOT solve the question
- Do NOT explain anything
- Use LaTeX for math
- Keep original wording

Output format:

Question:
{extracted question here}

Diagram:
[Only labels, values, symbols]


Options:
A.
B.
C.
D.

If no academic question exists return:
No academic content detected.
If no image and option available but question available, return question only.
Question: {Extracted question text}
`,
    });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/png",
          data: base64Image,
        },
      },
    ]);

    return result.response.text();
  } catch (error) {
    console.error("Image description failed:", error.message);
    return "";
  }
}

/* ---------------- Add Question ---------------- */

async function addNewQuestion(queryText, extractedText = "") {
  const fullText = [queryText, extractedText].join(" ").trim();

  const vector = await generateEmbedding(fullText);

  const newId = generateQuestionId();

  await index.upsert([
    {
      id: newId,
      values: vector,
    },
  ]);

  if (db) {
    await db.collection("questions").doc(newId).set({
      question: fullText,
      comment: "Thank you for your question. Our team will answer soon.",
      videoUrl: "",
      imageUrl: "",
      embedded: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return newId;
}

/* ---------------- Embed Pending ---------------- */

async function embedPendingQuestions() {
  if (!db) return;

  const snapshot = await db
    .collection("questions")
    .where("embedded", "==", false)
    .limit(20)
    .get();

  if (snapshot.empty) return;

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.question) continue;

    try {
      const vector = await generateEmbedding(data.question);

      await index.upsert([
        {
          id: doc.id,
          values: vector,
        },
      ]);

      await doc.ref.update({ embedded: true });

      console.log("✅ Embedded:", doc.id);
    } catch (err) {
      console.error("Embedding error:", err.message);
    }
  }
}

setInterval(embedPendingQuestions, 60000);

/* ---------------- Search API ---------------- */

app.post("/api/search", async (req, res) => {
  try {
    const { text, imageBase64 } = req.body;

    let finalQuery = text || "";
    let extractedText = "";

    if (imageBase64) {
      const base64 = imageBase64.includes(",")
        ? imageBase64.split(",")[1]
        : imageBase64;

      extractedText = await describeImage(base64);

      if (extractedText.trim()) {
        finalQuery += " " + extractedText;
      }
    }

    if (!finalQuery.trim()) {
      return res.json([{ id: "#0000" }]);
    }

    const vector = await generateEmbedding(finalQuery);

    const queryResponse = await index.query({
      vector,
      topK: 1,
      includeMetadata: false,
    });

    if (
      queryResponse.matches &&
      queryResponse.matches.length > 0 &&
      queryResponse.matches[0].score > 0.6
    ) {
      return res.json([{ id: queryResponse.matches[0].id }]);
    }

    const newId = await addNewQuestion(text || "", extractedText);

    res.json([{ id: newId }]);
  } catch (error) {
    console.error("Critical error:", error);

    res.status(500).json([
      {
        id: "#0000",
        error: "Internal server error",
      },
    ]);
  }
});

/* ---------------- Health ---------------- */

app.get("/health", (req, res) => {
  res.send("Active");
});

/* ---------------- Start ---------------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
