require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://smsancfrhqtjikolpryz.supabase.co").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_OGrDiFIXNKWk55jjryeTXA_QwGg7I-f";
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "*").trim();

const ALLOWED_CATEGORIES = ["Books", "Study Tools", "Electronics", "Mobiles", "Accessories"];
const DEFAULT_MODELS = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash-lite"
].filter((v, i, arr) => v && arr.indexOf(v) === i);

/* ================= MIDDLEWARE ================= */
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGIN === "*") return cb(null, true);
    const allowed = ALLOWED_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    return cb(new Error("Origin not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "256kb" }));

// Lightweight in-memory rate limiter (35 AI requests / minute per IP)
const rateMap = new Map();
function rateLimitAi(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "local";
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 35;
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  rateMap.set(ip, entry);
  if (entry.count > maxReq) {
    return res.status(429).json({
      error: "Too many AI requests right now. Please wait a minute and try again."
    });
  }
  next();
}

/* ================= HELPERS ================= */
class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function cleanText(val, maxLen = 1000) {
  return String(val == null ? "" : val).trim().slice(0, maxLen);
}

function parseJsonSafe(rawText) {
  const text = String(rawText || "").trim();
  if (!text) throw new AppError("AI returned an empty response. Please try again.", 502);
  try {
    return JSON.parse(text);
  } catch (_) {
    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(stripped);
    } catch (_err) {
      const start = stripped.indexOf("{");
      const end = stripped.lastIndexOf("}");
      if (start !== -1 && end > start) {
        return JSON.parse(stripped.slice(start, end + 1));
      }
      throw new AppError("AI returned an unreadable response. Please try again.", 502);
    }
  }
}

/**
 * Fetch ONLY public columns from active (non-sold_out) listings in Supabase.
 * Never fetches seller_phone, user_id, emails, or purchase_requests.
 */
async function fetchLiveProducts() {
  const selectCols = "id,name,category,price,condition,location,description,status";
  const url = `${SUPABASE_URL}/rest/v1/products?select=${encodeURIComponent(selectCols)}&order=created_at.desc&limit=120`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      console.error("Supabase products lookup failed:", response.status);
      return [];
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) return [];

    return rows
      .filter(p => p && p.status !== "sold_out")
      .map(p => ({
        id: String(p.id),
        name: cleanText(p.name, 100),
        category: cleanText(p.category, 40),
        price: Number(p.price || 0),
        condition: cleanText(p.condition, 30),
        location: cleanText(p.location, 80),
        description: cleanText(p.description, 220)
      }));
  } catch (err) {
    console.error("Supabase fetch error:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Google Gemini REST API using GEMINI_API_KEY from server/.env.
 * Automatically falls back across models and disables Google Search grounding
 * if the Free Tier returns 429/400 for search grounding.
 */
async function callGeminiJson(systemPrompt, userPayload, options = {}) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    throw new AppError(
      "Campus ReUse AI is not configured yet. Please add a valid GEMINI_API_KEY in server/.env and restart the server.",
      503
    );
  }

  const useSearch = Boolean(options.useSearch);
  const temperature = typeof options.temperature === "number" ? options.temperature : 0.35;
  let lastError = null;
  let sawRateLimit = false;

  for (const model of DEFAULT_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), useSearch ? 28000 : 22000);

    try {
      const generationConfig = { temperature };
      if (!useSearch) {
        generationConfig.responseMimeType = "application/json";
      }

      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          {
            role: "user",
            parts: [{ text: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload) }]
          }
        ],
        generationConfig
      };

      if (useSearch) {
        body.tools = [{ google_search: {} }];
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (response.status === 404) {
        lastError = new AppError(`Model ${model} unavailable`, 502);
        continue;
      }

      if (response.status === 429) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody?.error?.message || "Rate limit / quota reached";
        console.warn(`[Gemini 429 on ${model}${useSearch ? " + search" : ""}]: ${detail}`);
        sawRateLimit = true;
        // If search grounding triggered the free-tier 429, immediately fall back to non-search mode
        if (useSearch) {
          break;
        }
        lastError = new AppError("Campus ReUse AI is busy right now (rate limit reached). Please wait a few seconds and try again.", 429);
        continue;
      }

      if (response.status === 400 || response.status === 401 || response.status === 403) {
        const errBody = await response.json().catch(() => ({}));
        const detail = errBody?.error?.message || "";
        console.warn(`[Gemini ${response.status} on ${model}]: ${detail}`);
        if (/api key|permission|credential/i.test(detail)) {
          throw new AppError("Invalid or unauthorized GEMINI_API_KEY in server/.env. Please check your key.", 503);
        }
        if (useSearch) {
          break;
        }
        throw new AppError("AI request could not be processed. Please try rephrasing your input.", 400);
      }

      if (!response.ok) {
        lastError = new AppError("Campus ReUse AI is temporarily unavailable. Please try again shortly.", 502);
        continue;
      }

      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const rawText = parts.map(p => p.text || "").join("\n").trim();
      const parsed = parseJsonSafe(rawText);

      const usedWebSearch = Boolean(
        data?.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ||
        data?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length
      );
      if (useSearch && parsed && typeof parsed === "object") {
        parsed._usedWebSearch = usedWebSearch;
      }
      return parsed;
    } catch (err) {
      if (err instanceof AppError && (err.status === 503 || (!useSearch && err.status === 400))) {
        throw err;
      }
      if (err.name === "AbortError") {
        lastError = new AppError("Campus ReUse AI timed out. Please try again.", 504);
        continue;
      }
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Automatic fallback: if search grounding failed or hit free-tier 429, retry cleanly without search
  if (useSearch) {
    console.log("Retrying price estimate without Google Search grounding...");
    return callGeminiJson(systemPrompt, userPayload, { ...options, useSearch: false });
  }

  if (sawRateLimit) {
    throw new AppError("Campus ReUse AI is busy right now (rate limit reached). Please wait 30 seconds and try again.", 429);
  }

  throw lastError instanceof AppError
    ? lastError
    : new AppError("Campus ReUse AI is temporarily unavailable. Please try again shortly.", 502);
}

/* ================= HEALTH CHECK ================= */
app.get("/api/health", (_req, res) => {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  res.json({
    ok: true,
    service: "Campus ReUse AI Server",
    aiConfigured: Boolean(key && key !== "your_gemini_api_key_here"),
    models: DEFAULT_MODELS
  });
});

/* ================= AI ROUTES ================= */
app.use("/api/ai", rateLimitAi);

// 1. AI Product Description Generator (Elaborative & Natural)
app.post("/api/ai/describe", async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 120);
    const brand = cleanText(req.body?.brand, 100);
    const condition = cleanText(req.body?.condition, 40);
    const originalPrice = cleanText(req.body?.originalPrice, 20);
    const sellingPrice = cleanText(req.body?.sellingPrice, 20);
    const notes = cleanText(req.body?.notes, 2000);

    if (!name && !notes) {
      return res.status(400).json({ error: "Please enter at least a product name or short information about the item." });
    }

    const systemPrompt = `You are Campus ReUse AI, an expert marketplace copywriter helping Indian college students write rich, persuasive, well-structured product listings.
WRITING STYLE & QUALITY:
- Write like a helpful, fluent human copywriter—NOT a robotic template or word rearranger.
- Expand the seller's short notes into complete, flowing, engaging sentences (4 to 6 rich sentences across 2 short paragraphs):
  Paragraph 1: Introduce the item warmly, explain how it helps a college student (e.g., classes, coding, assignments, exams, everyday campus use), and weave in EVERY specification/feature the seller gave.
  Paragraph 2: Clearly describe its reported condition, age/usage, and why it is a smart value pick on campus.
- Preserve 100% of every factual detail the seller typed (processor, RAM, storage, display size, edition, age, accessories, cosmetic notes). NEVER drop or shorten away important specs.
STRICT HONESTY RULES:
- Never invent hardware specs, RAM/storage, warranty, bill, box, or accessories that the seller did NOT mention.
- Never claim the item is certified genuine or in "perfect" condition unless stated.
- Choose "category" strictly from: ${ALLOWED_CATEGORIES.join(", ")}.
- Only return a numeric "suggestedPrice" (in INR) if originalPrice or enough pricing context is provided; otherwise null.
Return ONLY valid JSON:
{
  "title": "clear, catchy listing title (<= 75 chars)",
  "description": "elaborative 4-6 sentence listing (2 short paragraphs separated by \\n\\n) keeping all user facts",
  "highlights": ["3 to 6 detailed bullet points covering every key spec and condition detail from user input"],
  "category": "Books | Study Tools | Electronics | Mobiles | Accessories",
  "suggestedPrice": number or null
}`;

    const out = await callGeminiJson(
      systemPrompt,
      {
        productName: name,
        brandOrModel: brand,
        condition,
        originalPriceINR: originalPrice,
        sellingPriceINR: sellingPrice,
        shortInfo: notes
      },
      { temperature: 0.65 }
    );

    const category = ALLOWED_CATEGORIES.includes(out.category) ? out.category : "Accessories";
    const suggestedPrice =
      out.suggestedPrice != null && Number(out.suggestedPrice) > 0
        ? Math.round(Number(out.suggestedPrice))
        : null;

    res.json({
      ok: true,
      data: {
        title: cleanText(out.title || name, 80),
        description: cleanText(out.description, 2200),
        highlights: Array.isArray(out.highlights)
          ? out.highlights.map(h => cleanText(h, 200)).filter(Boolean).slice(0, 6)
          : [],
        category,
        suggestedPrice
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not generate description." });
  }
});

// 2. AI Description Rewrite (Elaborative, Complete Sentences, Zero Dropped Specs)
app.post("/api/ai/rewrite", async (req, res) => {
  try {
    const draft = cleanText(req.body?.draft, 2000);
    const name = cleanText(req.body?.name, 120);
    const condition = cleanText(req.body?.condition, 40);

    if (!draft || draft.length < 4) {
      return res.status(400).json({ error: "Please write a short draft description first so AI can rewrite it." });
    }

    const systemPrompt = `You are Campus ReUse AI, an expert e-commerce copywriter for a college student marketplace in India.
Rewrite the seller's draft into a polished, elaborative, natural-sounding product listing that actually feels written by a smart AI—not a bare-bones summary or rearranged keywords.
CRITICAL RULES:
- Preserve 100% of EVERY single fact, spec, processor generation, RAM, SSD/storage, screen size, age, price/value context, and condition detail from the draft. Do NOT cut, drop, or omit ANY specification!
- Fill in smooth, complete, engaging sentences: write a welcoming 3-5 sentence overview explaining the product and why it is great for college students/everyday use, followed by a clean bulleted "Key Highlights" list containing every spec and condition detail from the draft, and end with a friendly 1-sentence closing inviting interested campus buyers to send an offer.
- Never invent new technical specs, bill, box, warranty, or accessories that were not mentioned in the draft, item name, or condition.
Return ONLY valid JSON:
{
  "rewrittenDescription": "full elaborative rewritten listing with paragraphs and bullet points"
}`;

    const out = await callGeminiJson(
      systemPrompt,
      { itemName: name, condition, draft },
      { temperature: 0.65 }
    );
    const rewritten = cleanText(out.rewrittenDescription, 2600);
    if (!rewritten) throw new AppError("Could not rewrite the description. Please try again.", 502);

    res.json({ ok: true, data: { rewrittenDescription: rewritten } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not rewrite description." });
  }
});

// 3. AI Resale Price Estimator (Compares New Retail vs. Second-Hand Benchmarks in India)
app.post("/api/ai/estimate", async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 120);
    const brand = cleanText(req.body?.brand, 100);
    const originalPrice = cleanText(req.body?.originalPrice, 20);
    const age = cleanText(req.body?.age, 60);
    const condition = cleanText(req.body?.condition, 40);
    const damage = cleanText(req.body?.damage, 250);

    if (!name && !brand) {
      return res.status(400).json({ error: "Please enter the product name or brand/model to estimate a price." });
    }

    const systemPrompt = `You are Campus ReUse AI, a sharp resale pricing analyst for an Indian college student marketplace (all prices in INR ₹).
TASK:
1. Compare the item against typical NEW retail prices in India (Amazon.in, Flipkart, brand stores) AND typical SECOND-HAND / REFURBISHED prices in India (OLX India, Cashify, Amazon Renewed) for this product/model.
2. Combine that comparison with the seller's exact originalPrice, age, condition, and reported damage/missing accessories to compute a fair, realistic student-to-student resale range.

REALISTIC AGE & DEPRECIATION ANCHORS (always respect the stated age!):
- Open-box / days to 1 month old (e.g., 1 day old, 1 week old): retains ~83% to 92% of original price (deduct ~3–6% if minor cosmetic scratches are reported). Example: a 1-day-old ₹60,000 laptop with minor scratches should be around ₹49,000–₹54,000 (suggested ~₹51,500), NOT ₹35,000–₹42,000.
- 2 to 6 months old, good/like-new: retains ~72% to 82%.
- 6 to 12 months old, good condition: retains ~58% to 70%.
- 1 to 2 years old, good condition: retains ~45% to 58%.
- Over 2 years old or heavy wear/missing accessories: retains ~30% to 45%.
- Textbooks & scientific calculators in good condition: typically ~45% to 65% of current retail price.

RULES:
- In "reason", concisely compare the typical new retail range in India vs. typical second-hand/refurbished resale range, and clearly explain how the item's exact age and condition shaped the suggested price.
- Clearly frame it as an approximate resale estimate (never a guaranteed sale price).
- Only set "needsMoreInfo": true if BOTH originalPrice AND brand/model are missing for an expensive item like a phone or laptop.
- Output ONLY a single raw JSON object with NO markdown fences or extra commentary:
{
  "needsMoreInfo": false,
  "question": "",
  "minPrice": 49000,
  "maxPrice": 54000,
  "suggestedPrice": 51500,
  "reason": "2-3 clear sentences comparing new retail prices vs. second-hand market prices and factoring in exact age and condition."
}`;

    const out = await callGeminiJson(
      systemPrompt,
      {
        productName: name,
        brandOrModel: brand,
        originalPriceINR: originalPrice,
        age,
        condition,
        damageOrMissingAccessories: damage,
        region: "India (INR)"
      },
      { useSearch: false, temperature: 0.3 }
    );

    if (out.needsMoreInfo) {
      return res.json({
        ok: true,
        data: {
          needsMoreInfo: true,
          question: cleanText(out.question || "Please share the brand/model and approximate original price (₹) for a fair estimate.", 260)
        }
      });
    }

    const minPrice = Math.max(1, Math.round(Number(out.minPrice || 0)));
    const maxPrice = Math.max(minPrice, Math.round(Number(out.maxPrice || minPrice)));
    const suggestedPrice = Math.max(1, Math.round(Number(out.suggestedPrice || Math.round((minPrice + maxPrice) / 2))));

    res.json({
      ok: true,
      data: {
        needsMoreInfo: false,
        minPrice,
        maxPrice,
        suggestedPrice,
        usedWebSearch: Boolean(out._usedWebSearch),
        reason: cleanText(
          out.reason || "Approximate resale estimate comparing typical new retail and second-hand market prices in India for the stated age and condition.",
          650
        )
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not estimate price." });
  }
});

// 4. AI Smart Product Search
app.post("/api/ai/search", async (req, res) => {
  try {
    const query = cleanText(req.body?.query, 240);
    if (!query) {
      return res.status(400).json({ error: "Please type what you are looking for." });
    }

    const liveProducts = await fetchLiveProducts();
    if (!liveProducts.length) {
      return res.json({
        ok: true,
        data: {
          productIds: [],
          summary: "No active listings are currently available on Campus ReUse."
        }
      });
    }

    const systemPrompt = `You are Campus ReUse AI Smart Search. Match the student's natural-language search query strictly against the provided active database listings.
STRICT RULES:
- ONLY return IDs that exist verbatim in the provided "listings" array. NEVER invent products or IDs.
- Understand product type, synonyms (e.g. scientific calculator -> Study Tools / Casio), budget constraints ("under ₹10,000" or "below 5000" means price <= budget), category, condition, brand/model, and location keywords.
- Rank the best matches first.
- If no listing genuinely satisfies the request (especially budget or item type), return an empty array [] and clearly state in "summary" that no matching listings are currently available.
Return strict JSON:
{
  "productIds": ["id1", "id2"],
  "summary": "1 concise friendly sentence summarizing the result"
}`;

    const out = await callGeminiJson(systemPrompt, { query, listings: liveProducts }, { temperature: 0.2 });
    const validIds = new Set(liveProducts.map(p => p.id));
    const verifiedIds = Array.isArray(out.productIds)
      ? out.productIds.map(String).filter((id, idx, arr) => validIds.has(id) && arr.indexOf(id) === idx)
      : [];

    res.json({
      ok: true,
      data: {
        productIds: verifiedIds,
        summary: verifiedIds.length
          ? cleanText(out.summary || `Found ${verifiedIds.length} matching listing(s).`, 220)
          : cleanText(out.summary || "No matching listings are currently available on Campus ReUse.", 220)
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "AI search failed." });
  }
});

// 5. AI Product Recommendations
app.post("/api/ai/recommend", async (req, res) => {
  try {
    const currentId = cleanText(req.body?.productId, 80);
    const liveProducts = (await fetchLiveProducts()).filter(p => p.id !== currentId);
    if (!liveProducts.length) {
      return res.json({ ok: true, data: { productIds: [] } });
    }

    const systemPrompt = `You are Campus ReUse AI Recommendations. Given the product a student is currently viewing, pick up to 4 relevant active listings from "availableListings" (e.g., related textbooks, study materials, scientific calculators for math/engineering books, similar category, or complementary student gear).
STRICT RULES:
- Return ONLY IDs present in "availableListings". NEVER invent items.
- Do not include the item currently being viewed.
- If nothing is reasonably related, return [].
Return strict JSON:
{
  "productIds": ["id1", "id2"]
}`;

    const out = await callGeminiJson(
      systemPrompt,
      {
        viewing: {
          name: cleanText(req.body?.name, 100),
          category: cleanText(req.body?.category, 40),
          price: Number(req.body?.price || 0),
          condition: cleanText(req.body?.condition, 30),
          description: cleanText(req.body?.description, 220)
        },
        availableListings: liveProducts
      },
      { temperature: 0.25 }
    );

    const validIds = new Set(liveProducts.map(p => p.id));
    const verifiedIds = Array.isArray(out.productIds)
      ? out.productIds.map(String).filter((id, idx, arr) => validIds.has(id) && arr.indexOf(id) === idx).slice(0, 4)
      : [];

    res.json({ ok: true, data: { productIds: verifiedIds } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not load recommendations." });
  }
});

// 6. AI Marketplace Chatbot
app.post("/api/ai/chat", async (req, res) => {
  try {
    const message = cleanText(req.body?.message, 600);
    const history = Array.isArray(req.body?.history)
      ? req.body.history.slice(-6).map(h => ({
          role: h?.role === "assistant" ? "assistant" : "user",
          text: cleanText(h?.text, 350)
        }))
      : [];

    if (!message) {
      return res.status(400).json({ error: "Please enter a message." });
    }

    const liveProducts = await fetchLiveProducts();

    const systemPrompt = `You are Campus ReUse AI, the friendly built-in assistant for the Campus ReUse college student marketplace.
EXACT APP WORKFLOWS (answer usage questions accurately):
- Sell an item: Log in -> click "＋ Sell" in the top-right -> fill item details (or use "AI Price Brief", "Generate with AI", and "AI Rewrite") -> click "Publish Listing". A 10-digit phone number is required during registration.
- Make an offer / Buy: Click any product card -> click "Request & Make Offer" -> enter your offer price (₹) and pickup message -> click "Send Offer".
- Contact the seller: Seller phone numbers remain private until the seller accepts your offer. Once accepted, click your Profile Avatar (top-right) -> "My Orders & Activity" -> "My Buying Requests" to view the seller's phone number and pickup location.
- Manage selling listings & offers: Profile Avatar -> "My Orders & Activity" -> "My Selling Listings" to Accept or Reject incoming offers, Mark as Sold Out, or Delete listings.
- Notifications: Click the bell icon (🔔) in the header; a red dot shows unread offers or accept/reject updates.
- Student buying tips: Give concise, practical checks when asked (e.g., check display/keys/solar cell on calculators; screen, battery, camera, charging port, and IMEI on used phones).

STRICT RULES:
- If the user asks to find or browse products, match ONLY against "activeListings" below and include matching IDs in "productIds". NEVER invent products, sellers, or prices. If nothing matches, clearly state no matching listings are currently available.
- If the user asks for a description or price estimate inside chat, do not invent specs/warranty and clarify that price suggestions are approximate estimates.
- Stay focused on Campus ReUse and student buying/selling. If asked something unrelated, reply briefly and politely guide them back to marketplace help.
- Never claim a listed product is genuine, verified, or in perfect condition.
Return strict JSON:
{
  "reply": "helpful plain-text response (concise, warm, short bullet points allowed)",
  "productIds": ["optional matching active product IDs"]
}`;

    const out = await callGeminiJson(
      systemPrompt,
      {
        recentConversation: history,
        userMessage: message,
        activeListings: liveProducts.slice(0, 80)
      },
      { temperature: 0.45 }
    );

    const validIds = new Set(liveProducts.map(p => p.id));
    const verifiedIds = Array.isArray(out.productIds)
      ? out.productIds.map(String).filter((id, idx, arr) => validIds.has(id) && arr.indexOf(id) === idx).slice(0, 4)
      : [];

    res.json({
      ok: true,
      data: {
        reply: cleanText(
          out.reply || "I'm Campus ReUse AI! Ask me to search for items, estimate a resale price, write a listing description, or explain how Campus ReUse works.",
          1500
        ),
        productIds: verifiedIds
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Campus ReUse AI is temporarily unavailable." });
  }
});

/* ================= STATIC FRONTEND (LOCAL CONVENIENCE) ================= */
const clientDir = path.join(__dirname, "..", "client");
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

// Fallback JSON error handler
app.use((err, _req, res, _next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Unexpected server error." });
});

app.listen(PORT, () => {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  console.log(`Campus ReUse AI server running at http://localhost:${PORT}`);
  if (!key || key === "your_gemini_api_key_here") {
    console.warn("WARNING: GEMINI_API_KEY is not set in server/.env yet. Add your key and restart.");
  }
});