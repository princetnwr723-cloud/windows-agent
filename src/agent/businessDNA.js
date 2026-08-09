// src/agent/businessDNA.js
// ═══════════════════════════════════════════════════════════
// BUSINESS DNA — World's First Persistent Business Context AI
// User ek baar business introduce karta hai
// Agent us business ka DNA store karta hai
// 24/7 us business ke liye kaam karta hai
// ═══════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const DNA_DIR  = path.join(os.homedir(), ".vnus-agent");
const DNA_FILE = path.join(DNA_DIR, "business-dna.json");
const INSIGHTS_FILE = path.join(DNA_DIR, "business-insights.json");
const BRIEFINGS_DIR = path.join(DNA_DIR, "briefings");

// ── Default DNA Structure ──────────────────────────────────
const DEFAULT_DNA = {
  version: "1.0",
  createdAt: null,
  lastUpdated: null,
  setupComplete: false,

  // Core Business Info
  business: {
    name: null,
    type: null,           // SaaS, ecommerce, agency, startup, freelancer etc
    industry: null,
    description: null,
    founded: null,
    stage: null,          // idea, mvp, growth, scale, enterprise
    website: null,
    location: null,
  },

  // Product / Service
  product: {
    name: null,
    description: null,
    targetCustomer: null,
    painSolved: null,
    uniqueValue: null,    // What makes it different
    pricing: [],          // [{plan: "Pro", price: "$29/mo", features: [...]}]
    freeTrialDays: null,
  },

  // Business Metrics
  metrics: {
    mrr: null,            // Monthly Recurring Revenue
    arr: null,            // Annual Recurring Revenue
    users: null,
    trialUsers: null,
    conversionRate: null,
    churnRate: null,
    cac: null,            // Customer Acquisition Cost
    ltv: null,            // Lifetime Value
    nps: null,
    goals: [],            // [{metric: "MRR", target: "$50K", timeline: "6 months"}]
  },

  // Competitors
  competitors: [],        // [{name, weakness, ourEdge}]

  // Team
  team: {
    size: null,
    roles: [],
    founders: [],
  },

  // Marketing
  marketing: {
    channels: [],         // Which channels they use
    bestChannel: null,
    targetAudience: null,
    brandVoice: null,     // Professional, casual, technical, friendly
    keywords: [],
  },

  // Tech Stack
  tech: {
    stack: [],
    hosting: null,
    mainLanguage: null,
    repos: [],
  },

  // Current Problems
  problems: [],           // What they're struggling with

  // Agent Role
  agentRole: null,        // CEO, CMO, CTO, CFO, SALES, CUSTOM
  agentName: null,        // User-given name to the agent
  customRole: null,       // If CUSTOM — what role exactly

  // Priorities
  currentFocus: null,     // What to focus on right now
  weeklyGoals: [],
  doNotTouch: [],         // Things agent should not do
};

// ── Init ──────────────────────────────────────────────────
function initDNA() {
  if (!fs.existsSync(DNA_DIR)) fs.mkdirSync(DNA_DIR, { recursive: true });
  if (!fs.existsSync(BRIEFINGS_DIR)) fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });

  if (!fs.existsSync(DNA_FILE)) {
    const dna = { ...DEFAULT_DNA, createdAt: new Date().toISOString() };
    saveDNA(dna);
    return dna;
  }
  return loadDNA();
}

// ── Load / Save ───────────────────────────────────────────
function loadDNA() {
  try {
    return JSON.parse(fs.readFileSync(DNA_FILE, "utf8"));
  } catch {
    return initDNA();
  }
}

function saveDNA(dna) {
  dna.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DNA_FILE, JSON.stringify(dna, null, 2));
}

// ── Check if DNA is set up ─────────────────────────────────
function isDNASetup() {
  const dna = loadDNA();
  return dna.setupComplete && dna.business.name;
}

// ── 20 Questions Setup Flow ────────────────────────────────
const SETUP_QUESTIONS = [
  {
    id: "business_name",
    question: "What is your business or project name?",
    field: ["business", "name"],
    example: "e.g. TaskFlow, MyStartup, John's Agency",
  },
  {
    id: "business_type",
    question: "What type of business is it?",
    field: ["business", "type"],
    example: "e.g. SaaS, E-commerce, Agency, Freelancer, Startup, Content Creator",
    options: ["SaaS", "E-commerce", "Agency", "Freelancer", "Startup", "Content Creator", "Physical Product", "Service Business", "Other"],
  },
  {
    id: "description",
    question: "Describe your business in 2-3 sentences. What do you do and who for?",
    field: ["business", "description"],
    example: "e.g. We help remote teams manage projects with AI. Our tool is for small businesses with 10-50 employees.",
  },
  {
    id: "product_name",
    question: "What is your main product or service called?",
    field: ["product", "name"],
    example: "e.g. TaskFlow Pro, SEO Audit Service, Custom Websites",
  },
  {
    id: "target_customer",
    question: "Who is your ideal customer? Describe them specifically.",
    field: ["product", "targetCustomer"],
    example: "e.g. SaaS founders with $10K-100K MRR, busy freelance designers, e-commerce store owners",
  },
  {
    id: "unique_value",
    question: "What makes you different from competitors? Your unique advantage?",
    field: ["product", "uniqueValue"],
    example: "e.g. Only tool with AI-powered task assignment, 10x cheaper than competitors",
  },
  {
    id: "pricing",
    question: "What are your pricing plans? (name and price)",
    field: ["_pricing"],
    example: "e.g. Free: $0, Pro: $29/mo, Enterprise: $99/mo",
  },
  {
    id: "competitors",
    question: "Who are your top 3 competitors? What are their weaknesses?",
    field: ["_competitors"],
    example: "e.g. Asana (too complex), Monday.com (too expensive), Trello (no AI)",
  },
  {
    id: "mrr",
    question: "What is your current Monthly Revenue (MRR/ARR)? Or how many customers?",
    field: ["metrics", "mrr"],
    example: "e.g. $5,000 MRR, 200 customers, pre-revenue, $50K ARR",
  },
  {
    id: "goal",
    question: "What is your #1 business goal for the next 6 months?",
    field: ["_goal"],
    example: "e.g. Reach $50K MRR, Launch mobile app, Get 1000 users, Raise seed round",
  },
  {
    id: "current_problem",
    question: "What is your biggest challenge right now?",
    field: ["_problem"],
    example: "e.g. Low trial-to-paid conversion, No organic traffic, High churn, Scaling team",
  },
  {
    id: "marketing_channels",
    question: "Which marketing channels do you currently use or want to use?",
    field: ["_channels"],
    example: "e.g. Twitter/X, LinkedIn, SEO, Cold email, Product Hunt, Reddit, YouTube",
  },
  {
    id: "brand_voice",
    question: "How should your brand communicate? Pick a voice.",
    field: ["marketing", "brandVoice"],
    example: "Professional, Casual & friendly, Technical & detailed, Bold & direct, Inspirational",
    options: ["Professional", "Casual & Friendly", "Technical & Detailed", "Bold & Direct", "Inspirational", "Humorous"],
  },
  {
    id: "tech_stack",
    question: "What technology do you use? (optional but helps for technical tasks)",
    field: ["_tech"],
    example: "e.g. React, Node.js, Supabase, AWS, Shopify, WordPress",
  },
  {
    id: "team_size",
    question: "What is your team size? Are you solo or with a team?",
    field: ["team", "size"],
    example: "e.g. Solo founder, 2 co-founders, Team of 5, 20 employees",
  },
  {
    id: "agent_role",
    question: "What role should I take in your business?",
    field: ["agentRole"],
    example: "CEO (strategy), CMO (marketing), CTO (tech), CFO (finance), Sales (growth), or tell me a custom role",
    options: ["CEO — Strategy & Growth", "CMO — Marketing & Content", "CTO — Technology", "CFO — Finance & Revenue", "Sales — Lead Gen & Outreach", "Custom Role"],
  },
  {
    id: "agent_name",
    question: "Do you want to give me a name? Or I'll be 'Vnus' by default.",
    field: ["agentName"],
    example: "e.g. Atlas, Nova, Rex, or just leave blank for Vnus",
  },
  {
    id: "current_focus",
    question: "What should I focus on most RIGHT NOW for your business?",
    field: ["currentFocus"],
    example: "e.g. Growing Twitter following, Fixing onboarding, Writing content, Finding investors",
  },
  {
    id: "do_not",
    question: "Is there anything I should NOT do or touch? Any boundaries?",
    field: ["_doNot"],
    example: "e.g. Don't send emails without approval, Don't post on social without review, Don't touch production DB",
  },
  {
    id: "extra",
    question: "Anything else important I should know about your business?",
    field: ["_extra"],
    example: "e.g. We're raising a seed round, Our app launches in 2 months, We're in a regulated industry",
  },
];

// ── Process a setup answer ─────────────────────────────────
function processSetupAnswer(questionId, answer, dna) {
  const q = SETUP_QUESTIONS.find(q => q.id === questionId);
  if (!q) return dna;

  const ans = answer.trim();

  // Simple field assignment
  if (q.field[0] !== "_") {
    let obj = dna;
    for (let i = 0; i < q.field.length - 1; i++) {
      obj = obj[q.field[i]];
    }
    obj[q.field[q.field.length - 1]] = ans;
    return dna;
  }

  // Complex parsing
  switch (q.field[0]) {
    case "_pricing": {
      // Parse "Free: $0, Pro: $29/mo, Enterprise: $99/mo"
      const parts = ans.split(/[,;]/).map(p => p.trim());
      dna.product.pricing = parts.map(p => {
        const match = p.match(/(.+?):\s*(\$[\d,]+.*)/);
        return match ? { plan: match[1].trim(), price: match[2].trim() } : { plan: p, price: "Contact us" };
      });
      break;
    }
    case "_competitors": {
      // Parse "Asana (too complex), Monday.com (too expensive)"
      const parts = ans.split(/[,;]/).map(p => p.trim());
      dna.competitors = parts.map(p => {
        const match = p.match(/(.+?)\s*\((.+?)\)/);
        return match
          ? { name: match[1].trim(), weakness: match[2].trim(), ourEdge: dna.product.uniqueValue || "" }
          : { name: p, weakness: "", ourEdge: "" };
      });
      break;
    }
    case "_goal": {
      dna.metrics.goals = [{ description: ans, timeline: "6 months", set: new Date().toISOString() }];
      break;
    }
    case "_problem": {
      dna.problems = [{ description: ans, priority: "high", identified: new Date().toISOString() }];
      break;
    }
    case "_channels": {
      dna.marketing.channels = ans.split(/[,;]/).map(c => c.trim()).filter(Boolean);
      break;
    }
    case "_tech": {
      dna.tech.stack = ans.split(/[,;]/).map(t => t.trim()).filter(Boolean);
      break;
    }
    case "_doNot": {
      dna.doNotTouch = ans.split(/[,;]/).map(d => d.trim()).filter(Boolean);
      break;
    }
    case "_extra": {
      if (!dna.business.description) {
        dna.business.description = ans;
      } else {
        dna.business.description += " " + ans;
      }
      break;
    }
  }

  return dna;
}

// ── Complete setup ─────────────────────────────────────────
function completeSetup(dna) {
  dna.setupComplete = true;

  // Set agent name default
  if (!dna.agentName) dna.agentName = "Vnus";

  // Parse agent role
  if (dna.agentRole?.includes("CEO")) dna.agentRole = "CEO";
  else if (dna.agentRole?.includes("CMO")) dna.agentRole = "CMO";
  else if (dna.agentRole?.includes("CTO")) dna.agentRole = "CTO";
  else if (dna.agentRole?.includes("CFO")) dna.agentRole = "CFO";
  else if (dna.agentRole?.includes("Sales")) dna.agentRole = "SALES";
  else if (dna.agentRole?.includes("Custom")) dna.agentRole = "CUSTOM";
  else dna.agentRole = "CEO";

  saveDNA(dna);
  console.log(`✅ Business DNA complete for: ${dna.business.name}`);
  return dna;
}

// ── Build Business Context Prompt ─────────────────────────
function buildBusinessPrompt() {
  const dna = loadDNA();
  if (!dna.setupComplete) return "";

  const role = getAgentRoleDescription(dna);

  let prompt = `\n═══ BUSINESS DNA ═══\n`;
  prompt += `You are ${dna.agentName || "Vnus"}, the ${role.title} of ${dna.business.name}.\n`;
  prompt += `Your job: ${role.job}\n\n`;

  prompt += `BUSINESS:\n`;
  prompt += `- Name: ${dna.business.name}\n`;
  prompt += `- Type: ${dna.business.type}\n`;
  prompt += `- Description: ${dna.business.description}\n`;
  if (dna.business.stage) prompt += `- Stage: ${dna.business.stage}\n`;

  prompt += `\nPRODUCT:\n`;
  prompt += `- Product: ${dna.product.name}\n`;
  prompt += `- Target Customer: ${dna.product.targetCustomer}\n`;
  prompt += `- Unique Value: ${dna.product.uniqueValue}\n`;
  if (dna.product.pricing?.length) {
    prompt += `- Pricing: ${dna.product.pricing.map(p => `${p.plan} ${p.price}`).join(", ")}\n`;
  }

  if (dna.metrics.mrr) {
    prompt += `\nMETRICS:\n`;
    prompt += `- Current MRR: ${dna.metrics.mrr}\n`;
    if (dna.metrics.goals?.length) {
      prompt += `- Goals: ${dna.metrics.goals.map(g => g.description).join(", ")}\n`;
    }
  }

  if (dna.competitors?.length) {
    prompt += `\nCOMPETITORS:\n`;
    dna.competitors.forEach(c => {
      prompt += `- ${c.name}: weakness = ${c.weakness}\n`;
    });
  }

  if (dna.problems?.length) {
    prompt += `\nCURRENT PROBLEMS:\n`;
    dna.problems.forEach(p => { prompt += `- ${p.description}\n`; });
  }

  if (dna.marketing.brandVoice) {
    prompt += `\nBRAND VOICE: ${dna.marketing.brandVoice}\n`;
  }

  if (dna.currentFocus) {
    prompt += `\nCURRENT FOCUS: ${dna.currentFocus}\n`;
  }

  if (dna.doNotTouch?.length) {
    prompt += `\nDO NOT: ${dna.doNotTouch.join(", ")}\n`;
  }

  prompt += `\nROLE INSTRUCTIONS:\n${role.instructions}\n`;
  prompt += `═══════════════════\n`;

  return prompt;
}

// ── Role Descriptions ──────────────────────────────────────
function getAgentRoleDescription(dna) {
  const roles = {
    CEO: {
      title: "AI Chief Executive Officer",
      job: "Drive business strategy, expansion, and long-term growth decisions.",
      instructions: `As CEO:
- Always think about business impact first.
- Prioritize actions that move MRR/growth metrics.
- Identify opportunities before the user asks.
- Give strategic recommendations, not just task completions.
- Monitor competitors proactively.
- When doing any task, explain the business impact.
- Suggest 1 strategic insight after completing each task.`,
    },
    CMO: {
      title: "AI Chief Marketing Officer",
      job: "Create content, grow audience, and build brand awareness.",
      instructions: `As CMO:
- All content must match the brand voice.
- Every post/email/copy must serve a business goal.
- Always think about target customer before writing.
- Suggest distribution channel for every piece of content.
- Track what's working and what's not.
- Suggest A/B test ideas.`,
    },
    CTO: {
      title: "AI Chief Technology Officer",
      job: "Make technical decisions, write code, and architect systems.",
      instructions: `As CTO:
- Always consider scalability and maintainability.
- Prefer battle-tested solutions over novel ones.
- Document everything you build.
- Suggest tech debt fixes proactively.
- Security-first approach always.`,
    },
    CFO: {
      title: "AI Chief Financial Officer",
      job: "Optimize revenue, reduce costs, and improve financial metrics.",
      instructions: `As CFO:
- Always connect work to revenue/cost impact.
- Identify revenue leaks and opportunities.
- Track metrics that matter: MRR, CAC, LTV, Churn.
- Suggest pricing experiments.`,
    },
    SALES: {
      title: "AI Sales & Growth Lead",
      job: "Generate leads, write outreach, and grow customer base.",
      instructions: `As Sales Lead:
- Every interaction should move toward a sale.
- Personalize outreach always.
- Follow up relentlessly but respectfully.
- Track pipeline and report progress.`,
    },
    CUSTOM: {
      title: dna.customRole || "AI Business Assistant",
      job: `Help with ${dna.currentFocus || "business tasks"}.`,
      instructions: `Focus on what helps the business most right now: ${dna.currentFocus || "general business support"}.`,
    },
  };

  return roles[dna.agentRole] || roles.CEO;
}

// ── Daily Briefing Generator ───────────────────────────────
function generateDailyBriefing(insights) {
  const dna = loadDNA();
  if (!dna.setupComplete) return null;

  const date = new Date().toISOString().split("T")[0];
  const role = getAgentRoleDescription(dna);

  const briefing = {
    date,
    businessName: dna.business.name,
    agentName: dna.agentName,
    agentRole: dna.agentRole,
    generatedAt: new Date().toISOString(),
    sections: {
      greeting: `Good morning. I'm ${dna.agentName}, your ${role.title} for ${dna.business.name}.`,
      focus: dna.currentFocus || "Growing the business",
      insights: insights || [],
      tasksQueued: [],
      recommendation: "",
    },
  };

  // Save briefing
  const file = path.join(BRIEFINGS_DIR, `briefing-${date}.json`);
  fs.writeFileSync(file, JSON.stringify(briefing, null, 2));

  return briefing;
}

// ── Update DNA with new info ───────────────────────────────
function updateDNA(field, value) {
  const dna = loadDNA();

  // Handle nested fields like "metrics.mrr"
  const parts = field.split(".");
  let obj = dna;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;

  saveDNA(dna);
  console.log(`🧬 DNA updated: ${field} = ${value}`);
}

// ── Get quick DNA summary ──────────────────────────────────
function getDNASummary() {
  const dna = loadDNA();
  if (!dna.setupComplete) return "Business DNA not set up yet.";

  return `${dna.business.name} | ${dna.business.type} | ${dna.agentRole} mode | Focus: ${dna.currentFocus || "Growth"}`;
}

module.exports = {
  initDNA,
  loadDNA,
  saveDNA,
  isDNASetup,
  SETUP_QUESTIONS,
  processSetupAnswer,
  completeSetup,
  buildBusinessPrompt,
  getAgentRoleDescription,
  generateDailyBriefing,
  updateDNA,
  getDNASummary,
};