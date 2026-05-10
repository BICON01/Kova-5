const express = require("express");
const bodyParser = require("body-parser");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, "data");
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function rj(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function wj(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const DB = {
  cfg:       () => rj(path.join(DATA, "config.json"), {}),
  saveCfg:   (d) => wj(path.join(DATA, "config.json"), { ...DB.cfg(), ...d }),
  biz:       () => rj(path.join(DATA, "businesses.json"), []),
  saveBiz:   (d) => wj(path.join(DATA, "businesses.json"), d),
  leads:     () => rj(path.join(DATA, "leads.json"), []),
  saveLeads: (d) => wj(path.join(DATA, "leads.json"), d),
};

const conversations = {};

// ── Industry definitions with default audience profiles ───────────────────────
const INDUSTRY_PROFILES = {
  "Fashion & Clothing": { audience: "Women and men aged 18-40, fashion-conscious, Instagram-heavy, trend-driven", triggers: ["new arrivals", "limited stock", "style", "look good"] },
  "Beauty & Skincare": { audience: "Women aged 18-45, beauty-conscious, value results and transformation", triggers: ["glowing skin", "results", "natural ingredients", "before and after"] },
  "Electronics & Gadgets": { audience: "Men and women aged 20-45, tech-savvy, value quality and warranty", triggers: ["latest model", "warranty", "original", "fast delivery"] },
  "Food & Beverages": { audience: "Families and young adults, convenience-seekers, value taste and freshness", triggers: ["fresh", "fast delivery", "tasty", "affordable"] },
  "Health & Wellness": { audience: "Adults aged 25-50, health-conscious, motivated by results and transformation", triggers: ["lose weight", "feel better", "natural", "proven results"] },
  "Home & Furniture": { audience: "Couples and families aged 25-50, homeowners, value quality and aesthetics", triggers: ["upgrade your home", "quality", "durable", "stylish"] },
  "Real Estate": { audience: "Working adults aged 28-55, aspiring homeowners and investors", triggers: ["investment", "dream home", "flexible payment", "location"] },
  "Education & Coaching": { audience: "Students and professionals aged 16-40, career-driven, value certification", triggers: ["get certified", "career growth", "learn online", "flexible"] },
  "Restaurants & Food Delivery": { audience: "Busy professionals and families, convenience-first, value speed", triggers: ["order now", "delivered hot", "satisfaction guaranteed", "discount"] },
  "Spas & Salons": { audience: "Women aged 20-45, self-care driven, value experience and results", triggers: ["treat yourself", "relax", "look your best", "appointment"] },
  "Gym & Fitness": { audience: "Adults aged 18-45, fitness-motivated, value results and community", triggers: ["transform your body", "free trial", "results guaranteed", "join now"] },
  "Travel & Tourism": { audience: "Adults aged 25-50, experience-seekers, plan ahead, value deals", triggers: ["getaway", "affordable packages", "memories", "book now"] },
  "Finance & Insurance": { audience: "Working adults aged 25-55, security-driven, value trust and stability", triggers: ["secure your future", "low premium", "trusted", "protect your family"] },
  "Retail & Physical Store": { audience: "Local community, all ages, value convenience and good deals", triggers: ["shop now", "discount", "come in today", "best prices"] },
  "Automobile & Car Sales": { audience: "Adults aged 25-55, aspirational, value reliability and prestige", triggers: ["drive your dream", "test drive", "best price", "certified"] },
  "IT Services & Startups": { audience: "Business owners and professionals aged 25-45, efficiency-driven", triggers: ["grow faster", "automate", "save time", "results"] },
  "Events & Entertainment": { audience: "Young adults aged 18-40, social, experience-driven", triggers: ["don't miss out", "limited tickets", "unforgettable", "register now"] },
  "HR & Recruitment": { audience: "Business owners and HR professionals aged 28-50", triggers: ["hire faster", "best candidates", "save time", "trusted"] },
  "Other": { audience: "Nigerian buyers across various demographics", triggers: ["quality", "value", "trusted", "results"] },
};

// ── Service recommendation engine ─────────────────────────────────────────────
function recommendServices(diagnosis) {
  const { visibility, challenge, messages, adsExperience, budget } = diagnosis;
  let services = [];
  let reason = "";

  const needsAds = visibility === "word_of_mouth" || visibility === "not_many" || challenge === "need_awareness" || adsExperience === "never";
  const needsCSR = challenge === "dms_not_buying" || challenge === "ghost_after_price" || messages === "falls_through" || messages === "reply_myself";
  const needsEmail = challenge === "need_repeat" || challenge === "all_above";

  if (challenge === "all_above") {
    services = ["ads", "csr", "email"];
    reason = "Based on your answers, you need full support — getting more customers, converting them, and bringing them back.";
  } else {
    if (needsAds) services.push("ads");
    if (needsCSR) services.push("csr");
    if (needsEmail) services.push("email");
    if (services.length === 0) services = ["csr"];

    const labels = { ads: "Ads & Campaigns", csr: "Customer Service", email: "Email Follow-ups" };
    reason = `Based on your answers, we recommend ${services.map(s => labels[s]).join(" + ")} for your business.`;
  }

  // Determine plan
  let plan = "custom";
  if (services.includes("ads") && services.includes("csr") && services.includes("email")) plan = "suite";
  else if (services.includes("ads") && services.includes("csr")) plan = "growth";
  else if (services.length === 1 && services[0] === "csr") plan = "starter";

  const prices = { ads: 10000, csr: 10000, email: 8000 };
  const price = services.reduce((s, v) => s + prices[v], 0);
  const bundlePrice = plan === "suite" ? 35000 : plan === "growth" ? 25000 : plan === "starter" ? 15000 : price;

  return { services, plan, price: bundlePrice, reason, isBundle: plan !== "custom" };
}

// ── Deep Research ─────────────────────────────────────────────────────────────
async function deepResearch(biz) {
  const cfg = DB.cfg();
  if (!cfg.ANTHROPIC_API_KEY) throw new Error("Anthropic API key not configured. Go to Setup tab.");
  const ai = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });

  const services = Array.isArray(biz.services) ? biz.services : [];
  const profile = INDUSTRY_PROFILES[biz.industry] || INDUSTRY_PROFILES["Other"];
  const audience = biz.targetAudience || profile.audience;
  const diagnosis = biz.diagnosis || {};
  const isFirstTimeSeller = diagnosis.adsExperience === "never" || diagnosis.adsExperience === "tried_failed";
  const needsAds = services.includes("ads");
  const needsCSR = services.includes("csr");
  const needsEmail = services.includes("email");

  const prompt = `You are a world-class Nigerian digital marketing strategist. Analyse this business and create a complete strategy.

BUSINESS PROFILE:
Name: ${biz.name}
Industry: ${biz.industry}
Products/Services: ${biz.products || "Not specified"}
Location: ${biz.location || "Nigeria"}
Price Range: NGN ${biz.priceMin || "0"} to NGN ${biz.priceMax || "0"}
Top Sellers: ${biz.topSellers || "Not specified"}
Target Audience: ${audience}
Instagram: ${biz.instagram || "Not provided"}
First time running ads: ${isFirstTimeSeller ? "YES - build awareness first" : "NO - has some experience"}
Services Needed: ${services.join(", ")}

DIAGNOSIS CONTEXT:
Visibility: ${diagnosis.visibility || "unknown"}
Main Challenge: ${diagnosis.challenge || "unknown"}
Message Handling: ${diagnosis.messages || "unknown"}
Budget Range: ${diagnosis.budget || "unknown"}

Return ONLY a raw valid JSON object starting with { and ending with }. No markdown, no explanation.

{
  "audienceInsights": {
    "who": "Precise description of ideal Nigerian customer for this business",
    "painPoints": ["pain 1", "pain 2", "pain 3"],
    "desires": ["desire 1", "desire 2", "desire 3"],
    "buyingTriggers": ["trigger 1", "trigger 2", "trigger 3"],
    "whereTheyHangOut": "Which platforms and where online they spend time"
  },
  "adsStrategy": ${needsAds ? `{
    "marketIntelligence": {
      "whatCompetitorsDo": "Specific things Nigerian competitors in this niche do well in marketing - be very specific",
      "competitorWeaknesses": "Specific gaps competitors have that this business can exploit immediately",
      "yourEdge": "The single most powerful competitive advantage this business has",
      "bestPlatforms": ["platform 1", "platform 2"],
      "bestPostingTimes": "Specific best days and times to post for Nigerian audience in this niche",
      "emotionalAngle": "The core emotional angle that moves Nigerian buyers in this niche to act"
    },
    "coldStartNote": "${isFirstTimeSeller ? "This business is starting fresh. Focus on trust-building for first 30 days before hard selling." : "This business has some ad experience. Focus on conversion optimization."}",
    "recommendedStrategy": {
      "approach": "Overall recommended strategy in 2-3 sentences",
      "primaryPlatform": "Single best platform to start on and exactly why",
      "contentPillars": ["pillar 1", "pillar 2", "pillar 3"],
      "keyMessage": "The single most powerful message for all ads",
      "audienceTargeting": "Precise audience targeting definition for ad platforms"
    },
    "lowBudgetCampaign": {
      "budgetRange": "NGN 5,000 to NGN 20,000 per month",
      "goal": "What this campaign achieves",
      "platform": "Platform and why",
      "instagramCaption": "Full ready-to-post Instagram caption with emojis and relevant Nigerian hashtags",
      "facebookAd": "Full ready-to-post Facebook ad copy",
      "whatsappBroadcast": "Ready-to-send WhatsApp broadcast message",
      "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
      "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8"],
      "expectedResults": "Realistic reach and leads at this budget",
      "tips": ["tip 1", "tip 2", "tip 3"]
    },
    "highBudgetCampaign": {
      "budgetRange": "NGN 50,000 to NGN 200,000 per month",
      "goal": "What this campaign achieves at scale",
      "platforms": ["platform 1", "platform 2"],
      "instagramCaption": "Full ready-to-post Instagram caption different angle from low budget",
      "facebookAd": "Full ready-to-post Facebook ad copy different angle from low budget",
      "whatsappBroadcast": "Ready-to-send WhatsApp broadcast message",
      "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6", "kw7", "kw8"],
      "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5", "#tag6", "#tag7", "#tag8", "#tag9", "#tag10"],
      "expectedResults": "Realistic reach and leads at higher budget",
      "extraActivities": ["activity 1", "activity 2", "activity 3"]
    }
  }` : "null"},
  "csrStrategy": ${needsCSR ? `{
    "agentName": "Aria",
    "personality": "How Aria should sound and present for this specific brand",
    "openingMessage": "First message Aria sends when someone DMs after seeing an ad or finding the page",
    "productKnowledge": "Key things Aria must know about this business products to answer questions",
    "objectionHandlers": {
      "tooExpensive": "Exact response when customer says price is too high",
      "poorQuality": "Exact response when customer questions quality or authenticity",
      "notTrusting": "Exact response when customer seems skeptical",
      "willThinkAboutIt": "Exact response when customer says they will think about it",
      "noMoneyNow": "Exact response when customer says they cannot afford it right now"
    },
    "closingScript": "What Aria says when customer is ready to buy to collect their details",
    "escalationTriggers": ["situation 1 that needs human takeover", "situation 2"]
  }` : "null"},
  "emailStrategy": ${needsEmail ? `{
    "welcomeEmail": {
      "subject": "Subject line for welcome email",
      "body": "Full welcome email body"
    },
    "sequence": [
      {"day": 1, "subject": "Day 1 subject", "body": "Day 1 email body targeting their main pain point"},
      {"day": 3, "subject": "Day 3 subject", "body": "Day 3 email with social proof and value"},
      {"day": 7, "subject": "Day 7 subject", "body": "Day 7 email with urgency and offer"}
    ],
    "reEngagement": {
      "subject": "Re-engagement subject for cold leads",
      "body": "Re-engagement email for leads who went cold after 14+ days"
    }
  }` : "null"}
}`;

  const resp = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  });

  let raw = resp.content[0].text.trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  // Find JSON boundaries
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1) raw = raw.substring(start, end + 1);

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Research parse error:", e.message);
    return { error: true, message: "Research completed but could not be parsed. Please try again." };
  }
}

// ── CSR Agent ─────────────────────────────────────────────────────────────────
async function agentReply(phone, message, biz) {
  const cfg = DB.cfg();
  if (!cfg.ANTHROPIC_API_KEY) throw new Error("No API key");
  const ai = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  if (!conversations[phone]) conversations[phone] = [];
  conversations[phone].push({ role: "user", content: message });

  const r = biz.research || {};
  const csr = r.csrStrategy || {};
  const ins = r.audienceInsights || {};

  const system = `You are ${csr.agentName || "Aria"}, expert AI sales agent for ${biz.name}.
Products: ${biz.products || "various"} | Price: NGN ${biz.priceMin || 0}-${biz.priceMax || 0}
Brand Voice: ${csr.personality || "warm, professional, persuasive"}
Pain Points: ${(ins.painPoints || []).join(", ")}
Buying Triggers: ${(ins.buyingTriggers || []).join(", ")}
Product Knowledge: ${csr.productKnowledge || ""}
Objection - Price: ${csr.objectionHandlers?.tooExpensive || "Focus on value"}
Objection - Trust: ${csr.objectionHandlers?.notTrusting || "Build trust with specifics"}
Objection - Delay: ${csr.objectionHandlers?.willThinkAboutIt || "Address their concern"}
Closing: ${csr.closingScript || "Collect name and address to process order"}
RULES: Keep replies 2-4 sentences. WhatsApp style. Warm and relatable for Nigerians.
Detect emotion and adjust: EXCITED=match energy+close fast, HESITANT=slow down+build trust, SKEPTICAL=use specifics, COLD=find pain point
Add on new line (never shown to customer): [DEAL_READY] [NAME:firstname] [EMOTION:state]`;

  const resp = await ai.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 350,
    system,
    messages: conversations[phone]
  });

  const reply = resp.content[0].text;
  conversations[phone].push({ role: "assistant", content: reply });
  return reply;
}

// ═══════════════════════════ ROUTES ══════════════════════════════════════════

// Diagnosis → recommendation
app.post("/api/diagnose", (req, res) => {
  try {
    const result = recommendServices(req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Self signup
app.post("/api/signup", (req, res) => {
  try {
    const biz = {
      id: Date.now().toString(),
      ...req.body,
      status: "pending_research",
      phase: "onboarded",
      approved: false,
      onboardedBy: "self",
      subscriptionStatus: "trial",
      trialEnds: new Date(Date.now() + 7 * 86400000).toISOString(),
      leads: 0, deals: 0, research: null,
      adminNotes: "",
      createdAt: new Date().toISOString(),
    };
    const businesses = DB.biz();
    businesses.push(biz);
    DB.saveBiz(businesses);
    res.json({ ok: true, businessId: biz.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin register
app.post("/api/business/register", (req, res) => {
  try {
    const biz = {
      id: Date.now().toString(),
      ...req.body,
      status: "pending_research",
      phase: "onboarded",
      approved: false,
      onboardedBy: "admin",
      subscriptionStatus: "trial",
      trialEnds: new Date(Date.now() + 7 * 86400000).toISOString(),
      leads: 0, deals: 0, research: null,
      adminNotes: "",
      createdAt: new Date().toISOString(),
    };
    const businesses = DB.biz();
    businesses.push(biz);
    DB.saveBiz(businesses);
    res.json({ ok: true, businessId: biz.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run research
app.post("/api/business/:id/research", async (req, res) => {
  const businesses = DB.biz();
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: "Business not found" });
  biz.status = "researching";
  DB.saveBiz(businesses);
  try {
    const research = await deepResearch(biz);
    biz.research = research;
    biz.status = research.error ? "pending_research" : "pending_approval";
    biz.phase = research.error ? "onboarded" : "research_done";
    DB.saveBiz(businesses);
    res.json({ ok: !research.error, research, error: research.error ? research.message : null });
  } catch (e) {
    console.error("Research error:", e);
    biz.status = "pending_research";
    DB.saveBiz(businesses);
    res.status(500).json({ error: e.message });
  }
});

// Approve
app.post("/api/business/:id/approve", (req, res) => {
  const businesses = DB.biz();
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: "Not found" });
  biz.approved = true;
  biz.status = "active";
  biz.phase = "live";
  biz.approvedAt = new Date().toISOString();
  if (req.body.adminNotes) biz.adminNotes = req.body.adminNotes;
  DB.saveBiz(businesses);
  res.json({ ok: true });
});

// Request changes (send back for regeneration)
app.post("/api/business/:id/request-changes", async (req, res) => {
  const businesses = DB.biz();
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: "Not found" });
  biz.adminNotes = req.body.notes || "";
  biz.status = "researching";
  DB.saveBiz(businesses);
  try {
    const research = await deepResearch({ ...biz, adminFeedback: req.body.notes });
    biz.research = research;
    biz.status = "pending_approval";
    DB.saveBiz(businesses);
    res.json({ ok: true, research });
  } catch (e) {
    biz.status = "pending_approval";
    DB.saveBiz(businesses);
    res.status(500).json({ error: e.message });
  }
});

// Update subscription
app.post("/api/business/:id/subscription", (req, res) => {
  const businesses = DB.biz();
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: "Not found" });
  biz.subscriptionStatus = req.body.status;
  if (req.body.status === "paid") {
    biz.paidAt = new Date().toISOString();
    biz.nextBillingDate = new Date(Date.now() + 30 * 86400000).toISOString();
  }
  DB.saveBiz(businesses);
  res.json({ ok: true });
});

// Update services
app.post("/api/business/:id/services", (req, res) => {
  const businesses = DB.biz();
  const biz = businesses.find(b => b.id === req.params.id);
  if (!biz) return res.status(404).json({ error: "Not found" });
  biz.services = req.body.services;
  biz.status = "pending_research";
  DB.saveBiz(businesses);
  res.json({ ok: true });
});

app.get("/api/businesses", (req, res) => res.json(DB.biz()));
app.get("/api/business/:id", (req, res) => {
  const b = DB.biz().find(x => x.id === req.params.id);
  b ? res.json(b) : res.status(404).json({ error: "Not found" });
});

// Leads
app.get("/api/leads", (req, res) => {
  let leads = DB.leads();
  if (req.query.businessId) leads = leads.filter(l => l.businessId === req.query.businessId);
  res.json(leads.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity)));
});
app.post("/api/lead/:id/status", (req, res) => {
  const leads = DB.leads();
  const l = leads.find(x => x.id == req.params.id);
  if (!l) return res.status(404).json({ error: "Not found" });
  l.status = req.body.status;
  DB.saveLeads(leads);
  res.json({ ok: true });
});
app.get("/api/conversation/:phone", (req, res) => res.json(conversations[decodeURIComponent(req.params.phone)] || []));

// Stats
app.get("/api/stats", (req, res) => {
  const b = DB.biz(), l = DB.leads();
  const revenue = b.filter(x => x.subscriptionStatus === "paid").reduce((s, x) => s + (x.monthlyPrice || 0), 0);
  res.json({
    totalBusinesses: b.length,
    activeBusinesses: b.filter(x => x.status === "active").length,
    pendingApproval: b.filter(x => x.status === "pending_approval").length,
    totalLeads: l.length,
    hotLeads: l.filter(x => x.status === "hot").length,
    closedDeals: l.filter(x => x.status === "closed").length,
    monthlyRevenue: revenue,
    trialClients: b.filter(x => x.subscriptionStatus === "trial").length,
    serviceBreakdown: {
      ads: b.filter(x => Array.isArray(x.services) && x.services.includes("ads")).length,
      csr: b.filter(x => Array.isArray(x.services) && x.services.includes("csr")).length,
      email: b.filter(x => Array.isArray(x.services) && x.services.includes("email")).length,
    }
  });
});

// Config
app.get("/api/config", (req, res) => {
  const cfg = DB.cfg();
  const safe = { ...cfg };
  if (safe.ANTHROPIC_API_KEY) safe.ANTHROPIC_API_KEY = "sk-***" + safe.ANTHROPIC_API_KEY.slice(-4);
  if (safe.TWILIO_AUTH_TOKEN) safe.TWILIO_AUTH_TOKEN = "***" + safe.TWILIO_AUTH_TOKEN.slice(-4);
  res.json({ configured: !!cfg.ANTHROPIC_API_KEY, ...safe });
});
app.post("/api/config", (req, res) => { DB.saveCfg(req.body); res.json({ ok: true }); });

// WhatsApp webhook
app.post("/webhook/whatsapp", async (req, res) => {
  const cfg = DB.cfg();
  const msg = req.body.Body || "", from = req.body.From || "";
  try {
    const businesses = DB.biz();
    const biz = businesses.find(b => b.approved && Array.isArray(b.services) && b.services.includes("csr"))
             || businesses.find(b => b.approved) || businesses[0];
    if (!biz) return res.status(200).send("No active business");

    const reply = await agentReply(from, msg, biz);
    const isDeal = reply.includes("[DEAL_READY]");
    const nameM = reply.match(/\[NAME:(.+?)\]/);
    const emoM = reply.match(/\[EMOTION:(.+?)\]/);
    const clean = reply.replace(/\[DEAL_READY\]/g, "").replace(/\[NAME:.+?\]/g, "").replace(/\[EMOTION:.+?\]/g, "").trim();

    const leads = DB.leads();
    let lead = leads.find(l => l.phone === from && l.businessId === biz.id);
    if (!lead) {
      lead = { id: Date.now(), businessId: biz.id, businessName: biz.name, service: "csr", phone: from, name: nameM ? nameM[1] : "Customer", status: "chatting", emotion: emoM ? emoM[1] : "unknown", firstContact: new Date().toISOString(), lastMessage: msg, lastActivity: new Date().toISOString() };
      leads.push(lead);
      biz.leads = (biz.leads || 0) + 1;
      DB.saveBiz(businesses);
    } else {
      lead.lastMessage = msg; lead.lastActivity = new Date().toISOString();
      if (nameM) lead.name = nameM[1]; if (emoM) lead.emotion = emoM[1];
    }
    if (isDeal) { lead.status = "hot"; biz.deals = (biz.deals || 0) + 1; DB.saveBiz(businesses); }
    DB.saveLeads(leads);

    if (cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN) {
      const twilio = require("twilio")(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({ from: `whatsapp:${cfg.TWILIO_WHATSAPP_FROM}`, to: from, body: clean });
      if (isDeal && cfg.OWNER_WHATSAPP) {
        await twilio.messages.create({ from: `whatsapp:${cfg.TWILIO_WHATSAPP_FROM}`, to: `whatsapp:${cfg.OWNER_WHATSAPP}`, body: `🔥 HOT LEAD — ${biz.name}\n👤 ${lead.name}\n📱 ${from}\n💬 "${msg}"\n\nCheck Kova dashboard now.` });
      }
    }
    res.status(200).send("OK");
  } catch (e) { console.error("Webhook:", e); res.status(500).send("Error"); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Kova v5 running on port ${PORT}`));
