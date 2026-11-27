/* ================= CAMPUS REUSE CONFIGURATION ================= */
const SUPABASE_URL = "https://smsancfrhqtjikolpryz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_OGrDiFIXNKWk55jjryeTXA_QwGg7I-f";
const IMAGE_BUCKET = "product-images";

const CATEGORIES = [
  ["All", "🛍️"],
  ["Books", "📚"],
  ["Study Tools", "🧮"],
  ["Electronics", "💻"],
  ["Mobiles", "📱"],
  ["Accessories", "🎒"]
];

// Replace this placeholder with your Render / Railway / Vercel backend URL when deploying online
const PRODUCTION_API_URL = "https://campus-reuse-ai.onrender.com";

// Auto-switch between localhost backend and deployed production backend
const API_BASE_URL = (() => {
  const host = window.location.hostname;
  const isLocal =
    window.location.protocol === "file:" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "";
  if (isLocal) {
    // If opened directly from Express on port 5000, use same origin; otherwise target localhost:5000
    return window.location.port === "5000" ? "" : "http://localhost:5000";
  }
  return PRODUCTION_API_URL.replace(/\/+$/, "");
})();
