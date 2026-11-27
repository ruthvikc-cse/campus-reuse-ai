/* ================= STATE ================= */
let db = null;
let currentUser = null;
let profile = null;
let allProducts = [];
let myBuy = [];
let mySell = [];
let activeCategory = "All";
let loaded = false;
let refreshing = false;
let pendingRefresh = false;
let rtTimer = null;

// AI search state shared with ai.js
let aiSearchIds = null;
let aiSearchMsg = "";

const $ = id => document.getElementById(id);
const same = (a, b) => String(a) === String(b);

/* ================= HELPERS ================= */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function safeImageUrl(url) {
  const s = String(url || "").trim();
  if (/^(https?:\/\/|data:image\/)/i.test(s)) return s;
  return "";
}

function money(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN");
}

function getVisual(p) {
  if (!p) return '<div class="photo-emoji">📦</div>';
  const imgUrl = safeImageUrl(p.image);
  return imgUrl
    ? `<img src="${esc(imgUrl)}" alt="${esc(p.name)}" loading="lazy" decoding="async">`
    : `<div class="photo-emoji">${esc(p.emoji || "📦")}</div>`;
}

function renderCard(p) {
  return `<article class="card" onclick="showDetail('${esc(p.id)}')">
    <div class="photo"><span class="tag">${esc(p.category)}</span>${getVisual(p)}</div>
    <div class="body">
      <div class="loc-pin">📍 ${esc(p.location || "Campus")}</div>
      <h3>${esc(p.name)}</h3><div class="desc">${esc(p.description)}</div>
      <div class="priceRow"><div class="price">${money(p.price)}</div><span class="condition">${esc(p.condition)}</span></div>
      <div class="seller">Seller: <b>${esc(p.seller)}</b></div>
    </div>
  </article>`;
}

let toastTimer;
function toast(m) {
  const t = $("toast");
  if (!t) return;
  t.textContent = m;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = "none"; }, 3500);
}

/* ================= INIT ================= */
function initApp() {
  $("catPanel").innerHTML = CATEGORIES.map(([c, i]) =>
    `<div class="cat-pill ${c === "All" ? "active" : ""}" data-cat="${esc(c)}" onclick="setCategory('${esc(c)}')">
      <span class="cat-icon">${i}</span>${c === "All" ? "All items" : esc(c)}
    </div>`
  ).join("");
  $("itemsGrid").innerHTML = '<div class="skel"></div>'.repeat(6);

  if (!window.supabase) {
    toast("Could not load Supabase. Check your internet connection and refresh.");
    return;
  }

  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // Defer Supabase calls outside auth callback to avoid client deadlock
  db.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED") return;
    setTimeout(() => handleSession(session), 0);
  });

  // Realtime updates (when enabled on Supabase tables); 20s polling acts as fallback
  try {
    db.channel("campus-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "products" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "purchase_requests" }, scheduleRefresh)
      .subscribe();
  } catch (e) {
    console.warn("Realtime subscription skipped:", e);
  }

  setInterval(() => { if (!document.hidden) refreshData(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshData(); });

  history.replaceState({ p: "homePage" }, "");
  window.addEventListener("popstate", e => showPage((e.state && e.state.p) || "homePage", false));

  // Initial public catalog load even before auth state finishes
  refreshData(true);
}

function scheduleRefresh() {
  clearTimeout(rtTimer);
  rtTimer = setTimeout(() => refreshData(), 400);
}

async function handleSession(session) {
  try {
    const u = session?.user || null;
    if (u && currentUser && same(u.id, currentUser.id) && profile) return;
    currentUser = u;
    profile = null;

    if (u) {
      const { data, error } = await db.from("profiles").select("*").eq("id", u.id).maybeSingle();
      if (error) console.warn("Profile read warning:", error.message);
      const m = u.user_metadata || {};
      profile = data || {
        id: u.id,
        full_name: m.full_name || u.email?.split("@")[0] || "Student",
        phone: m.phone || ""
      };
      if (!data) {
        db.from("profiles").upsert({
          id: u.id,
          full_name: profile.full_name,
          phone: profile.phone
        }).then(() => {}, () => {});
      }
      if (!profile.phone && m.phone) profile.phone = m.phone;
      closeAuth();
    } else {
      myBuy = [];
      mySell = [];
    }
  } catch (err) {
    console.error("Session error:", err);
  } finally {
    updateAuthUI();
    await refreshData(true);
  }
}

/* ================= DATA ================= */
async function refreshData(force) {
  if (!db) return;
  if (refreshing) {
    if (force) pendingRefresh = true;
    return;
  }
  refreshing = true;
  try {
    const jobs = [db.from("products").select("*").order("created_at", { ascending: false }).limit(200)];
    if (currentUser) {
      jobs.push(db.from("purchase_requests").select("*, products(*)").eq("buyer_id", currentUser.id).order("created_at", { ascending: false }));
      jobs.push(db.from("purchase_requests").select("*, products(*)").eq("seller_id", currentUser.id).order("created_at", { ascending: false }));
    }

    const [p, b, s] = await Promise.all(jobs);
    let changed = Boolean(force || !loaded);
    const upd = (cur, next) => {
      if (Array.isArray(next) && JSON.stringify(next) !== JSON.stringify(cur)) {
        changed = true;
        return next;
      }
      return cur;
    };

    if (p?.error) toast("Could not load items: " + p.error.message);
    if (b?.error) console.warn("Buy requests error:", b.error.message);
    if (s?.error) console.warn("Sell requests error:", s.error.message);

    allProducts = upd(allProducts, p?.data);
    if (currentUser) {
      myBuy = upd(myBuy, b?.data);
      mySell = upd(mySell, s?.data);
    }

    loaded = true;
    if (changed) {
      renderHome();
      if (currentUser) updateNotifications();
      if ($("ordersPage").classList.contains("active")) renderDashboard();
    }
  } catch (e) {
    console.error("Refresh error:", e);
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshData(true);
    }
  }
}

/* ================= HOME ================= */
function setCategory(cat) {
  activeCategory = cat;
  aiSearchIds = null;
  aiSearchMsg = "";
  const banner = $("aiSearchBanner");
  if (banner) banner.style.display = "none";
  document.querySelectorAll(".cat-pill").forEach(el => el.classList.toggle("active", el.dataset.cat === cat));
  renderHome();
}

function onSearchInput() {
  if (aiSearchIds !== null) {
    aiSearchIds = null;
    aiSearchMsg = "";
    const banner = $("aiSearchBanner");
    if (banner) banner.style.display = "none";
  }
  renderHome();
}

function renderHome() {
  if (!loaded) return;
  const live = allProducts.filter(p => p && p.status !== "sold_out");
  $("count").textContent = live.length;

  if (aiSearchIds !== null) {
    const byId = new Map(live.map(p => [String(p.id), p]));
    const matched = aiSearchIds.map(id => byId.get(String(id))).filter(Boolean);
    $("itemsGrid").innerHTML = matched.length
      ? matched.map(renderCard).join("")
      : `<div class="muted" style="grid-column:1/-1;text-align:center;padding:40px 0">${esc(aiSearchMsg || "No matching listings are currently available.")}</div>`;
    return;
  }

  const q = ($("search")?.value || "").trim().toLowerCase();
  const list = live.filter(p =>
    (activeCategory === "All" || p.category === activeCategory) &&
    ((p.name || "").toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q))
  );

  $("itemsGrid").innerHTML = list.length
    ? list.map(renderCard).join("")
    : '<div class="muted" style="grid-column:1/-1;text-align:center;padding:40px 0">No items match right now. Try “✨ AI Search” or tap “＋ Sell”.</div>';
}

function showDetail(id) {
  const p = allProducts.find(x => same(x.id, id));
  if (!p) {
    toast("That item is no longer available.");
    return;
  }
  const mine = currentUser && same(currentUser.id, p.user_id);
  let act;
  if (p.status === "sold_out") {
    act = '<div style="padding:15px;background:#f1f3f5;border-radius:12px;font-weight:bold">This item is sold out.</div>';
  } else if (mine) {
    act = '<div class="muted">This is your listing. Manage it in <a href="#" onclick="event.preventDefault();showOrders()">My Dashboard</a>.</div>';
  } else {
    const ex = myBuy.find(r => same(r.product_id, p.id));
    act = ex
      ? `<div style="padding:15px;background:#f4fbf6;border:1px solid #d3e6d8;border-radius:12px"><b>✓ Offer Sent</b><br><span class="muted">You offered ${money(ex.offer_price)}. Status: ${esc(ex.status).toUpperCase()}</span></div>`
      : `<button class="primary" style="font-size:16px;padding:14px 24px" onclick="openOfferModal('${esc(p.id)}','${esc(p.user_id)}',${Number(p.price)})">Request &amp; Make Offer</button>`;
  }

  $("detailContent").innerHTML = `<div class="detail-layout">
    <div class="detail-photo">${getVisual(p)}</div>
    <div class="detail-content">
      <div class="loc-pin">📍 Pickup: ${esc(p.location || "Campus")}</div>
      <h2>${esc(p.name)}</h2>
      <div class="price" style="font-size:34px;margin-bottom:15px">${money(p.price)}</div>
      <span class="condition">${esc(p.condition)}</span>
      <p style="margin:20px 0;line-height:1.7;color:#4a6355;white-space:pre-line">${esc(p.description)}</p>
      <div class="muted">Listed by: <b>${esc(p.seller)}</b></div>
      <div class="detail-actions">${act}</div>
    </div>
  </div>`;

  showPage("detailPage");
  if (typeof loadAiRecommendations === "function") {
    loadAiRecommendations(p);
  }
}

/* ================= OFFERS ================= */
function openOfferModal(prodId, sellerId, price) {
  if (!currentUser) {
    openAuth();
    toast("Please log in first.");
    return;
  }
  $("offerProdId").value = prodId;
  $("offerSellerId").value = sellerId;
  $("offerPrice").value = price;
  $("offerModal").style.display = "flex";
}

async function submitOffer(e) {
  e.preventDefault();
  const btn = $("offerSubmitBtn");
  const prodId = $("offerProdId").value;
  const price = Number($("offerPrice").value);
  if (!(price > 0)) {
    toast("Enter a valid price.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    const { error } = await db.from("purchase_requests").insert([{
      product_id: prodId,
      buyer_id: currentUser.id,
      seller_id: $("offerSellerId").value,
      buyer_name: profile?.full_name || "Student",
      offer_price: price,
      offer_message: $("offerMessage").value.trim()
    }]);
    if (error) {
      toast("Error: " + error.message);
      return;
    }
    $("offerModal").style.display = "none";
    $("offerMessage").value = "";
    toast("Offer sent to seller!");
    await refreshData(true);
    showDetail(prodId);
  } catch (err) {
    toast("Could not send offer. Please check your connection.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Offer";
  }
}

async function respondRequest(id, status) {
  try {
    const { error } = await db.from("purchase_requests")
      .update({ status, seller_read: true, buyer_read: false })
      .eq("id", id);
    if (error) toast("Error: " + error.message);
    else {
      toast("Offer " + status);
      refreshData(true);
    }
  } catch (_) {
    toast("Could not update offer. Please try again.");
  }
}

async function markSold(id) {
  if (!confirm("Mark this item as Sold Out?")) return;
  try {
    const { error } = await db.from("products").update({ status: "sold_out" }).eq("id", id);
    if (error) toast("Error: " + error.message);
    else {
      toast("Item marked as sold!");
      refreshData(true);
    }
  } catch (_) {
    toast("Could not update item status.");
  }
}

async function deleteListing(id) {
  if (!confirm("Delete this listing permanently?")) return;
  try {
    const { error } = await db.from("products").delete().eq("id", id);
    if (error) toast("Error: " + error.message);
    else {
      toast("Listing deleted.");
      refreshData(true);
    }
  } catch (_) {
    toast("Could not delete listing.");
  }
}

/* ================= NOTIFICATIONS ================= */
function updateNotifications() {
  let unread = 0;
  const items = [];
  mySell.forEach(r => {
    if (!r.seller_read) unread++;
    items.push({
      u: !r.seller_read,
      t: `💰 <b>${esc(r.buyer_name)}</b> offered ${money(r.offer_price)} for <b>${esc(r.products?.name || "your item")}</b>.`
    });
  });
  myBuy.forEach(r => {
    if (r.status !== "pending") {
      if (!r.buyer_read) unread++;
      items.push({
        u: !r.buyer_read,
        t: r.status === "accepted"
          ? `✅ Your offer for <b>${esc(r.products?.name || "an item")}</b> was accepted! Open to see the seller's number.`
          : `❌ Your offer for <b>${esc(r.products?.name || "an item")}</b> was rejected.`
      });
    }
  });
  $("bellBadge").style.display = unread ? "block" : "none";
  $("notifList").innerHTML = items.length
    ? items.map(n => `<div class="notif-item ${n.u ? "unread" : ""}" onclick="showOrders()">${n.t}</div>`).join("")
    : '<div class="muted" style="padding:15px;text-align:center">No notifications yet.</div>';
}

async function markAllRead() {
  if (!currentUser) return;
  try {
    await Promise.all([
      db.from("purchase_requests").update({ seller_read: true }).eq("seller_id", currentUser.id),
      db.from("purchase_requests").update({ buyer_read: true }).eq("buyer_id", currentUser.id).neq("status", "pending")
    ]);
    refreshData(true);
  } catch (_) {
    toast("Could not mark notifications as read.");
  }
}

/* ================= DASHBOARD ================= */
function showOrders() {
  if (!currentUser) {
    openAuth();
    return;
  }
  $("profileDropdown").style.display = "none";
  $("notifDropdown").style.display = "none";
  renderDashboard();
  showPage("ordersPage");
}

function switchTab(t) {
  $("tabBuying").classList.toggle("active", t === "buying");
  $("tabSelling").classList.toggle("active", t === "selling");
  $("buyingView").style.display = t === "buying" ? "block" : "none";
  $("sellingView").style.display = t === "selling" ? "block" : "none";
}

function renderDashboard() {
  if (!currentUser) return;
  const empty = m => `<div class="muted" style="padding:20px;background:#fff;border-radius:12px;border:1px solid var(--line)">${m}</div>`;

  $("buyingView").innerHTML = myBuy.length
    ? myBuy.map(r => `
      <div class="dash-card">
        <div class="dash-img">${getVisual(r.products)}</div>
        <div class="dash-info">
          <div class="dash-status status-${esc(r.status)}">${esc(r.status).toUpperCase()}</div>
          <h3 style="margin:0 0 5px">${esc(r.products?.name || "Item removed")}</h3>
          <div class="muted">Your offer: <b>${money(r.offer_price)}</b></div>
          ${r.status === "accepted" ? `<div class="req-box" style="background:#f4fbf6;border-color:#d3e6d8"><b>Seller contact:</b> ${esc(r.products?.seller_phone || "Number not provided")}<br><span class="muted">Call the seller to arrange pickup at ${esc(r.products?.location || "Campus")}.</span></div>` : ""}
          ${r.status === "rejected" ? '<div class="muted" style="margin-top:10px">The seller declined this offer.</div>' : ""}
        </div>
      </div>`).join("")
    : empty("You have not sent any buy requests.");

  const mine = allProducts.filter(p => same(p.user_id, currentUser.id));
  $("sellingView").innerHTML = mine.length
    ? mine.map(p => {
        const reqs = mySell.filter(r => same(r.product_id, p.id));
        const rh = reqs.map(r => `<div style="background:#fff;padding:12px;border-radius:8px;margin-bottom:8px;border:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span><b>${esc(r.buyer_name)}</b> offered <b style="color:var(--g)">${money(r.offer_price)}</b></span>
            <span class="dash-status status-${esc(r.status)}">${esc(r.status).toUpperCase()}</span>
          </div>
          <div class="muted" style="margin-bottom:10px">“${esc(r.offer_message)}”</div>
          ${r.status === "pending" ? `<button class="primary" style="padding:6px 12px;font-size:12px" onclick="respondRequest('${esc(r.id)}','accepted')">Accept</button> <button class="soft" style="padding:6px 12px;font-size:12px" onclick="respondRequest('${esc(r.id)}','rejected')">Reject</button>` : ""}
        </div>`).join("");
        const sold = p.status === "sold_out";
        return `<div class="dash-card">
          <div class="dash-img">${getVisual(p)}</div>
          <div class="dash-info">
            <div class="dash-status status-${sold ? "sold" : "accepted"}">${sold ? "SOLD OUT" : "ACTIVE LISTING"}</div>
            <h3 style="margin:0 0 5px">${esc(p.name)}</h3>
            <div class="price">${money(p.price)}</div>
            <div class="loc-pin" style="margin-top:6px">📍 Pickup: ${esc(p.location || "Campus")}</div>
            ${reqs.length ? `<div class="req-box"><div class="eyebrow" style="margin-bottom:10px">Incoming offers</div>${rh}</div>` : ""}
            <div style="margin-top:15px;display:flex;gap:10px;flex-wrap:wrap">
              ${sold ? "" : `<button class="soft" style="font-size:12px;padding:8px 14px" onclick="markSold('${esc(p.id)}')">Mark as Sold Out</button>`}
              <button style="background:none;color:#c1313a;font-size:12px;border:1px solid #fbdcdb;padding:8px 14px;border-radius:8px" onclick="deleteListing('${esc(p.id)}')">Delete Listing</button>
            </div>
          </div>
        </div>`;
      }).join("")
    : empty("You have not listed any items for sale.");
}

/* ================= SELLING ================= */
function openForm() {
  if (!currentUser) {
    openAuth();
    return;
  }
  if (!profile?.phone) {
    toast("Your account needs a phone number. Register with one to sell.");
    return;
  }
  if (typeof closeSellAi === "function") closeSellAi();
  $("backdrop").style.display = "flex";
}

function closeForm() {
  $("backdrop").style.display = "none";
  if (typeof closeSellAi === "function") closeSellAi();
}

function compressImage(file, maxW = 900, q = 0.7) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(maxW / img.width, 1);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? res(b) : rej(new Error("Compression failed"))), "image/jpeg", q);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("Could not read image"));
    };
    img.src = url;
  });
}

const blobToDataURL = b => new Promise((res, rej) => {
  const f = new FileReader();
  f.onload = () => res(f.result);
  f.onerror = () => rej(new Error("Could not encode image"));
  f.readAsDataURL(b);
});

async function uploadImage(file) {
  const blob = await compressImage(file);
  const path = `${currentUser.id}/${Date.now()}.jpg`;
  const { error } = await db.storage.from(IMAGE_BUCKET).upload(path, blob, {
    contentType: "image/jpeg",
    cacheControl: "31536000"
  });
  if (!error) return db.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  console.warn("Storage upload failed, using inline image:", error.message);
  return blobToDataURL(await compressImage(file, 500, 0.5));
}

async function addItem(e) {
  e.preventDefault();
  const priceVal = Number($("price").value);
  if (!(priceVal > 0)) {
    toast("Please enter a valid price greater than ₹0.");
    return;
  }

  const btn = $("publishBtn");
  btn.disabled = true;
  btn.textContent = "Preparing...";
  try {
    const c = $("category").value;
    const file = $("itemPhoto").files[0];
    btn.textContent = file ? "Uploading photo..." : "Publishing...";
    const image = file ? await uploadImage(file) : "";
    btn.textContent = "Publishing...";

    const { data, error } = await db.from("products").insert([{
      user_id: currentUser.id,
      name: $("name").value.trim(),
      category: c,
      price: priceVal,
      condition: $("condition").value,
      location: $("location").value.trim(),
      seller: profile?.full_name || "Student",
      seller_phone: profile?.phone || "",
      description: $("detail").value.trim(),
      image,
      emoji: ({ Books: "📚", "Study Tools": "🧮", Electronics: "💻", Accessories: "🎒" })[c] || "📱"
    }]).select();

    if (error) throw error;
    $("form").reset();
    closeForm();
    toast("Listing published!");
    if (data && data[0] && !allProducts.some(p => same(p.id, data[0].id))) {
      allProducts.unshift(data[0]);
    }
    loaded = true;
    setCategory("All");
    showPage("homePage");
    refreshData(true);
  } catch (err) {
    toast("Error: " + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Publish Listing";
  }
}

/* ================= PAGES & UI ================= */
function showPage(id, push = true) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = $(id);
  if (target) target.classList.add("active");
  window.scrollTo(0, 0);
  if (push && history.state?.p !== id) history.pushState({ p: id }, "");
}

function showHome() {
  showPage("homePage");
}

function showSettings() {
  $("profileDropdown").style.display = "none";
  showPage("settingsPage");
}

function toggleNotifs(e) {
  if (e) e.stopPropagation();
  const d = $("notifDropdown");
  d.style.display = d.style.display === "block" ? "none" : "block";
  $("profileDropdown").style.display = "none";
}

function toggleProfile(e) {
  if (e) e.stopPropagation();
  const d = $("profileDropdown");
  d.style.display = d.style.display === "block" ? "none" : "block";
  $("notifDropdown").style.display = "none";
}

window.addEventListener("click", e => {
  const nd = $("notifDropdown");
  const pd = $("profileDropdown");
  if (nd && !nd.contains(e.target) && !e.target.closest(".bell-wrapper")) nd.style.display = "none";
  if (pd && !pd.contains(e.target) && e.target !== $("profileAvatar")) pd.style.display = "none";
});

window.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  closeForm();
  closeAuth();
  if ($("offerModal")) $("offerModal").style.display = "none";
  if ($("sdgModal")) $("sdgModal").style.display = "none";
  if ($("aiChatPanel")) $("aiChatPanel").classList.remove("open");
});

/* ================= AUTH ================= */
function openAuth() {
  $("authBackdrop").style.display = "flex";
  setAuthMode("login");
}

function closeAuth() {
  $("authBackdrop").style.display = "none";
}

function setAuthMode(m) {
  const L = m === "login";
  $("loginForm").style.display = L ? "block" : "none";
  $("registerForm").style.display = L ? "none" : "block";
  $("loginTab").style.background = L ? "var(--g-light)" : "transparent";
  $("registerTab").style.background = L ? "transparent" : "var(--g-light)";
  $("authHeading").textContent = L ? "Log in" : "Register";
}

async function loginUser(e) {
  e.preventDefault();
  const b = $("loginSubmit");
  b.disabled = true;
  try {
    const { error } = await db.auth.signInWithPassword({
      email: $("loginIdentifier").value.trim(),
      password: $("loginPassword").value
    });
    toast(error
      ? (error.message.includes("not confirmed") ? "Please confirm your email first, then log in." : error.message)
      : "Logged in!");
  } catch (_) {
    toast("Network error while logging in. Please try again.");
  } finally {
    b.disabled = false;
  }
}

async function registerUser(e) {
  e.preventDefault();
  const b = $("registerSubmit");
  const phone = $("registerPhone").value.trim();
  if (!/^\d{10}$/.test(phone)) {
    toast("Enter a valid 10-digit phone number.");
    return;
  }
  b.disabled = true;
  try {
    const { data, error } = await db.auth.signUp({
      email: $("registerEmail").value.trim(),
      password: $("registerPassword").value,
      options: { data: { full_name: $("registerName").value.trim(), phone } }
    });
    if (error) {
      toast(error.message);
      return;
    }
    if (data?.session) toast("Account created. Welcome!");
    else {
      toast("Account created! Check your email to confirm, then log in.");
      setAuthMode("login");
    }
  } catch (_) {
    toast("Network error during registration. Please try again.");
  } finally {
    b.disabled = false;
  }
}

async function logout() {
  try {
    await db.auth.signOut();
    toast("Logged out.");
    history.pushState({ p: "homePage" }, "");
    showPage("homePage", false);
  } catch (_) {
    toast("Could not log out cleanly. Please refresh.");
  }
}

function updateAuthUI() {
  if (currentUser && profile) {
    const n = profile.full_name || "User";
    const ch = n.charAt(0).toUpperCase();
    $("profileAvatar").textContent = ch;
    $("dropdownAvatar").textContent = ch;
    $("dropdownName").textContent = n;
    $("dropdownPhone").textContent = profile.phone || "";
    $("authActions").style.display = "flex";
    $("authButton").style.display = "none";
  } else {
    $("authActions").style.display = "none";
    $("authButton").style.display = "block";
    $("profileDropdown").style.display = "none";
    $("notifDropdown").style.display = "none";
  }
}

initApp();
