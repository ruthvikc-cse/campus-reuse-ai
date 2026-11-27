/* ================= CAMPUS REUSE AI FRONTEND ================= */
let recSeq = 0;
let lastDescData = null;
let lastEstPrice = null;
let aiChatHistory = [];
let aiChatReady = false;
let aiBusy = false;

async function callCampusAi(endpoint, payload) {
  const url = `${API_BASE_URL}/api/ai/${endpoint}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
  } catch (_) {
    throw new Error("Could not reach the Campus ReUse AI server. Make sure the backend is running (npm start in server/).");
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok || data?.error) {
    throw new Error(data?.error || "Campus ReUse AI is temporarily unavailable. Please try again shortly.");
  }
  return data.data;
}

/* ================= SELL MODAL: PRICE BRIEF, DESCRIPTION & REWRITE ================= */
function toggleSellAi(mode) {
  const priceBox = $("aiPriceBox");
  const descBox = $("aiDescBox");
  const showPrice = mode === "price" && priceBox.style.display !== "block";
  const showDesc = mode === "desc" && descBox.style.display !== "block";

  priceBox.style.display = showPrice ? "block" : "none";
  descBox.style.display = showDesc ? "block" : "none";
  $("btnTogglePriceAi")?.classList.toggle("active", showPrice);
  $("btnToggleDescAi")?.classList.toggle("active", showDesc);
}

function closeSellAi() {
  if ($("aiPriceBox")) $("aiPriceBox").style.display = "none";
  if ($("aiDescBox")) $("aiDescBox").style.display = "none";
  if ($("aiEstResult")) $("aiEstResult").style.display = "none";
  if ($("aiDescResult")) $("aiDescResult").style.display = "none";
  if ($("aiRewriteResult")) $("aiRewriteResult").style.display = "none";
  $("btnTogglePriceAi")?.classList.remove("active");
  $("btnToggleDescAi")?.classList.remove("active");
}

// 1. AI Resale Price Estimator
async function runPriceEstimator() {
  const name = ($("name").value || "").trim() || ($("estBrand").value || "").trim();
  const brand = ($("estBrand").value || "").trim();
  if (!name && !brand) {
    toast("Tell AI what you are selling (Item Name or Brand/Model) first.");
    return;
  }

  const btn = $("aiEstRunBtn");
  const box = $("aiEstResult");
  btn.disabled = true;
  btn.textContent = "Estimating...";
  box.style.display = "block";
  box.innerHTML = '<div class="muted">Calculating an approximate student resale price brief...</div>';

  try {
    const res = await callCampusAi("estimate", {
      name,
      brand,
      originalPrice: ($("estOrigPrice").value || "").trim(),
      age: ($("estAge").value || "").trim(),
      condition: $("condition").value,
      damage: ($("estDamage").value || "").trim()
    });

    if (res.needsMoreInfo) {
      lastEstPrice = null;
      box.innerHTML = `
        <b>Need one quick detail:</b>
        <p style="margin:6px 0 0">${esc(res.question || "Please enter the brand/model or original price (₹) for an estimate.")}</p>`;
    } else {
      lastEstPrice = res.suggestedPrice ? Math.round(Number(res.suggestedPrice)) : null;
      box.innerHTML = `
        <div><b>Estimated Resale Range:</b> ${money(res.minPrice)} – ${money(res.maxPrice)}</div>
        ${lastEstPrice ? `<div style="margin-top:4px"><b>Suggested Listing Price:</b> <span style="color:var(--g);font-weight:800">${money(lastEstPrice)}</span></div>` : ""}
        <p class="muted" style="margin:6px 0 0">${esc(res.reason || "Approximate resale estimate based on the details provided.")}</p>
        <div class="muted" style="margin-top:4px;font-size:11.5px">Note: This is an approximate estimate, not a guaranteed market price. You stay in full control of your listing price.</div>
        <div class="ai-result-actions">
          ${lastEstPrice ? `<button type="button" class="primary" style="padding:7px 13px;font-size:12px" onclick="acceptEstPrice()">Accept Suggested Price (${money(lastEstPrice)})</button>` : ""}
          <button type="button" class="soft" style="padding:7px 13px;font-size:12px" onclick="runPriceEstimator()">Recalculate</button>
          <button type="button" style="background:none;color:#6b7b72;padding:7px 10px;font-size:12px" onclick="$('aiEstResult').style.display='none'">Cancel</button>
        </div>`;
    }
  } catch (err) {
    box.innerHTML = `<div style="color:#9c3029">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Get Price Brief";
  }
}

function acceptEstPrice() {
  if (!lastEstPrice) return;
  $("price").value = lastEstPrice;
  $("aiPriceBox").style.display = "none";
  $("btnTogglePriceAi")?.classList.remove("active");
  toast("Suggested price applied. You can edit it anytime before publishing.");
}

// 2. AI Product Description Generator
async function runDescGenerator() {
  const name = ($("name").value || "").trim();
  const notes = ($("aiNotes").value || "").trim();
  if (!name && !notes) {
    toast("Enter an Item Name or short details about the product first.");
    return;
  }

  const btn = $("aiDescRunBtn");
  const box = $("aiDescResult");
  btn.disabled = true;
  btn.textContent = "Generating...";
  box.style.display = "block";
  box.innerHTML = '<div class="muted">Drafting a clean, accurate listing from your details...</div>';

  try {
    const res = await callCampusAi("describe", {
      name,
      brand: ($("aiBrand").value || "").trim(),
      condition: $("condition").value,
      originalPrice: ($("aiOrigPrice").value || "").trim(),
      sellingPrice: ($("price").value || "").trim(),
      notes
    });

    lastDescData = res;
    const bullets = Array.isArray(res.highlights) && res.highlights.length
      ? "\n\nHighlights:\n" + res.highlights.map(h => "• " + h).join("\n")
      : "";
    const combinedDesc = (res.description || "") + bullets;

    box.innerHTML = `
      <label style="margin-bottom:4px">Suggested Title (editable)</label>
      <input id="aiOutTitle" class="field ai-compact" style="margin-bottom:8px" maxlength="80" value="${esc(res.title || name)}">
      <label style="margin-bottom:4px">Suggested Description (editable)</label>
      <textarea id="aiOutDesc" class="field ai-compact" rows="4">${esc(combinedDesc)}</textarea>
      <div class="muted" style="margin-top:6px">
        Suggested Category: <b>${esc(res.category)}</b>
        ${res.suggestedPrice ? ` · Approximate Price Idea: <b>${money(res.suggestedPrice)}</b>` : ""}
      </div>
      <div class="ai-result-actions">
        <button type="button" class="primary" style="padding:7px 13px;font-size:12px" onclick="applyAiDesc(false)">Use in Form</button>
        ${res.suggestedPrice ? `<button type="button" class="soft" style="padding:7px 13px;font-size:12px" onclick="applyAiDesc(true)">Use + Apply ${money(res.suggestedPrice)}</button>` : ""}
        <button type="button" class="soft" style="padding:7px 13px;font-size:12px" onclick="runDescGenerator()">Regenerate</button>
        <button type="button" style="background:none;color:#6b7b72;padding:7px 10px;font-size:12px" onclick="$('aiDescResult').style.display='none'">Cancel</button>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div style="color:#9c3029">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Listing";
  }
}

function applyAiDesc(includePrice) {
  const titleVal = ($("aiOutTitle")?.value || "").trim();
  const descVal = ($("aiOutDesc")?.value || "").trim();
  if (titleVal) $("name").value = titleVal.slice(0, 80);
  if (descVal) $("detail").value = descVal;
  if (lastDescData?.category) $("category").value = lastDescData.category;
  if (includePrice && lastDescData?.suggestedPrice) {
    $("price").value = Math.round(Number(lastDescData.suggestedPrice));
  }
  $("aiDescBox").style.display = "none";
  $("btnToggleDescAi")?.classList.remove("active");
  toast("AI draft added to form. Review everything before publishing!");
}

// 3. AI Rewrite (directly beside Description box)
async function runDescriptionRewrite() {
  const draft = ($("detail").value || "").trim();
  if (!draft) {
    toast("Type a rough description in the box first, then click AI Rewrite.");
    $("detail").focus();
    return;
  }

  const btn = $("aiRewriteBtn");
  const box = $("aiRewriteResult");
  btn.disabled = true;
  btn.textContent = "Rewriting...";
  box.style.display = "block";
  box.innerHTML = '<div class="muted">Polishing your description cleanly...</div>';

  try {
    const res = await callCampusAi("rewrite", {
      name: ($("name").value || "").trim(),
      condition: $("condition").value,
      draft
    });

    box.innerHTML = `
      <label style="margin-bottom:4px">✨ Rewritten Description (editable)</label>
      <textarea id="aiRewriteDraft" class="field ai-compact" rows="4">${esc(res.rewrittenDescription)}</textarea>
      <div class="ai-result-actions">
        <button type="button" class="primary" style="padding:7px 13px;font-size:12px" onclick="applyRewrite()">Use Rewritten</button>
        <button type="button" class="soft" style="padding:7px 13px;font-size:12px" onclick="runDescriptionRewrite()">Regenerate</button>
        <button type="button" style="background:none;color:#6b7b72;padding:7px 10px;font-size:12px" onclick="$('aiRewriteResult').style.display='none'">Cancel</button>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div style="color:#9c3029">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI Rewrite";
  }
}

function applyRewrite() {
  const text = ($("aiRewriteDraft")?.value || "").trim();
  if (text) $("detail").value = text;
  $("aiRewriteResult").style.display = "none";
  toast("Description updated!");
}

/* ================= AI SMART PRODUCT SEARCH ================= */
async function runAiSearch() {
  const q = ($("search").value || "").trim();
  if (!q) {
    toast("Type what you are looking for first.");
    return;
  }

  const btn = $("aiSearchBtn");
  btn.disabled = true;
  btn.textContent = "Searching...";
  try {
    const res = await callCampusAi("search", { query: q });
    aiSearchIds = Array.isArray(res.productIds) ? res.productIds : [];
    aiSearchMsg = res.summary || "";
    $("aiSearchSummary").innerHTML = `✨ <b>AI Search:</b> ${esc(aiSearchMsg)}`;
    $("aiSearchBanner").style.display = "flex";
    renderHome();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI Search";
  }
}

function clearAiSearch() {
  aiSearchIds = null;
  aiSearchMsg = "";
  $("search").value = "";
  $("aiSearchBanner").style.display = "none";
  renderHome();
}

/* ================= AI PRODUCT RECOMMENDATIONS ================= */
async function loadAiRecommendations(product) {
  const sec = $("aiRecsSection");
  const grid = $("aiRecsGrid");
  if (!sec || !grid || !product) return;

  const mySeq = ++recSeq;
  const others = allProducts.filter(p => p && p.status !== "sold_out" && !same(p.id, product.id));
  if (!others.length) {
    sec.style.display = "none";
    return;
  }

  sec.style.display = "block";
  grid.innerHTML = '<div class="skel"></div>'.repeat(Math.min(3, others.length));

  try {
    const res = await callCampusAi("recommend", {
      productId: String(product.id),
      name: product.name,
      category: product.category,
      price: product.price,
      condition: product.condition,
      description: product.description
    });
    if (mySeq !== recSeq) return;

    const liveMap = new Map(others.map(p => [String(p.id), p]));
    const picks = (res.productIds || []).map(id => liveMap.get(String(id))).filter(Boolean);
    if (picks.length) {
      grid.innerHTML = picks.map(renderCard).join("");
    } else {
      sec.style.display = "none";
    }
  } catch (_) {
    if (mySeq === recSeq) sec.style.display = "none";
  }
}

/* ================= BOTTOM-LEFT FLOATING AI CHATBOT ================= */
function toggleAiChat() {
  const panel = $("aiChatPanel");
  const opening = !panel.classList.contains("open");
  panel.classList.toggle("open", opening);

  if (opening && !aiChatReady) {
    aiChatReady = true;
    appendAiMsg(
      "bot",
      "Hi! I'm Campus ReUse AI. I can help you create product listings, estimate resale prices, and find items on your campus marketplace."
    );
  }
  if (opening) setTimeout(() => $("aiChatInput")?.focus(), 100);
}

function appendAiMsg(role, text, productIds = []) {
  const wrap = $("aiMsgs");
  const div = document.createElement("div");
  div.className = "ai-msg " + role;
  div.textContent = text;

  if (role === "bot" && Array.isArray(productIds) && productIds.length) {
    const liveMap = new Map(allProducts.filter(p => p && p.status !== "sold_out").map(p => [String(p.id), p]));
    const items = productIds.map(id => liveMap.get(String(id))).filter(Boolean);
    if (items.length) {
      const list = document.createElement("div");
      list.className = "ai-mini-list";
      list.innerHTML = items.map(p => {
        const imgUrl = safeImageUrl(p.image);
        return `<button type="button" class="ai-mini-card" onclick="openFromAiChat('${esc(p.id)}')">
          <div class="ai-mini-thumb">${imgUrl ? `<img src="${esc(imgUrl)}" alt="">` : esc(p.emoji || "📦")}</div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
            <div class="muted">${money(p.price)} · ${esc(p.condition)}</div>
          </div>
        </button>`;
      }).join("");
      div.appendChild(list);
    }
  }

  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function openFromAiChat(id) {
  $("aiChatPanel").classList.remove("open");
  showDetail(id);
}

function quickAiAction(type) {
  const input = $("aiChatInput");
  if (type === "desc") {
    if (currentUser && profile?.phone) {
      $("aiChatPanel").classList.remove("open");
      openForm();
      toggleSellAi("desc");
      return;
    }
    input.value = "Help me write a product description for my used engineering calculator in good condition.";
  } else if (type === "price") {
    if (currentUser && profile?.phone) {
      $("aiChatPanel").classList.remove("open");
      openForm();
      toggleSellAi("price");
      return;
    }
    input.value = "Estimate a resale price for a 1-year-old scientific calculator bought for ₹1,200 in good condition.";
  } else if (type === "find") {
    input.value = "Show me calculators or books in good condition under ₹1,000.";
  } else {
    input.value = "How do I make an offer and contact the seller on Campus ReUse?";
  }
  input.focus();
}

async function sendAiChat(e) {
  e.preventDefault();
  if (aiBusy) return;

  const input = $("aiChatInput");
  const text = (input.value || "").trim();
  if (!text) {
    toast("Please type a message first.");
    return;
  }

  input.value = "";
  appendAiMsg("user", text);
  aiChatHistory.push({ role: "user", text });

  aiBusy = true;
  $("aiSendBtn").disabled = true;

  const loader = document.createElement("div");
  loader.className = "ai-msg bot";
  loader.innerHTML = '<div class="ai-dots"><span></span><span></span><span></span></div>';
  $("aiMsgs").appendChild(loader);
  $("aiMsgs").scrollTop = $("aiMsgs").scrollHeight;

  try {
    const res = await callCampusAi("chat", { message: text, history: aiChatHistory });
    loader.remove();
    appendAiMsg("bot", res.reply, res.productIds || []);
    aiChatHistory.push({ role: "assistant", text: res.reply });
  } catch (err) {
    loader.remove();
    appendAiMsg("bot", err.message || "Sorry, Campus ReUse AI is temporarily unavailable. Please try again in a moment.");
  } finally {
    aiBusy = false;
    $("aiSendBtn").disabled = false;
  }
}
