# Campus ReUse — AI-Powered Student Marketplace

A full-stack peer-to-peer campus marketplace where college students can buy and sell pre-owned textbooks, engineering calculators, electronics, mobile phones, and accessories—upgraded with **Campus ReUse AI**.

## Folder Structure

```text
Campus-ReUse-AI/
├── .gitignore
├── README.md
├── client/
│   ├── index.html      # Marketplace UI, Sell modal AI helpers, Recommendations & Bottom-Left AI Chat
│   ├── styles.css      # Preserved green theme + responsive AI interface styles
│   ├── config.js       # Supabase public config + auto-switching backend API URL
│   ├── app.js          # Core marketplace logic (Auth, Listings, Offers, Dashboard, Notifications)
│   └── ai.js           # Campus ReUse AI frontend logic (Chat, Price Estimator, Description/Rewrite, Search, Recommendations)
└── server/
    ├── package.json    # Node.js + Express backend dependencies
    ├── .env.example    # Environment variable template (copy to .env)
    └── server.js       # Secure Express API server for Gemini AI + public Supabase product lookup
```

## Features

### Core Marketplace (Preserved)
- Supabase Email & Password Authentication (with 10-digit phone registration)
- User Profiles, Notifications bell with unread badge, Buying & Selling Dashboard
- Product listings with client-side image compression and Supabase Storage (`product-images`) upload
- Category filtering, keyword search, product detail pages, buyer offers, seller accept/reject, and mark-as-sold
- Realtime updates with 20-second polling fallback and UN SDG modal

### Campus ReUse AI Features
1. **Bottom-Left Floating AI Assistant (`Campus ReUse AI`)**: Responsive circular button on desktop & mobile with quick-action chips, live product cards, and campus marketplace Q&A.
2. **AI Resale Price Brief & Estimator**: Inside `+ Sell`, estimates a fair ₹ resale range & suggested price with explanation; updates the price field only after seller confirmation.
3. **AI Product Description Generator & AI Rewrite**: Inside `+ Sell`, generates a complete listing from short notes or rewrites rough drafts without inventing fake specifications or warranties.
4. **AI Smart Product Search**: Natural-language search (e.g., *"Show me calculators in good condition under ₹800"*) grounded strictly in active Supabase listings.
5. **AI Product Recommendations**: Displays *"AI Recommended for You"* on product detail pages using only currently active listings.

---

## Quick Start (Local Testing in VS Code)

### Prerequisites
- **Node.js 18+** (`node -v`)
- A free **Google Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey)

### 1. Configure Backend Environment
```bash
cd server
cp .env.example .env
```
*(On Windows PowerShell: `Copy-Item .env.example .env`)*

Open `server/.env` and paste your Gemini API key:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
```

### 2. Install & Run the Server
```bash
npm install
npm start
```
The server starts on **`http://localhost:5000`**.

### 3. Open the Website
- **Option A (Easiest):** Open **`http://localhost:5000`** directly in your browser (`server.js` automatically serves the `client/` folder).
- **Option B (VS Code Live Server):** Right-click `client/index.html` → **Open with Live Server**. `client/config.js` automatically connects to `http://localhost:5000`.

---

## Pushing to GitHub (Module 5 Lab Workflow)

Run these commands from inside the `Campus-ReUse-AI/` root folder:
```bash
git init
git status
```
Confirm **`node_modules/`** and **`server/.env`** are **NOT** listed in `git status`. Then run:
```bash
git add .
git commit -m "Initial Campus ReUse AI full-stack marketplace"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/campus-reuse-ai.git
git push -u origin main
```

---

## Deploying Live (Module 6)
1. **Backend (`server/`)**: Deploy the `server/` directory on **Render** or **Railway** and add `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `ALLOWED_ORIGIN` in the platform's Environment Variables.
2. **Frontend (`client/`)**: Update `PRODUCTION_API_URL` in `client/config.js` to your live backend URL, commit & push, then deploy the `client/` folder on **Netlify** or **Vercel**.
