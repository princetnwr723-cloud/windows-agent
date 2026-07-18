// src/agent/modelSelector.js
// JULY 2026 — Best models for PC control, coding, and daily tasks
// Research-based selection: Qwen3/Qwen3-Coder for coding+agents
// Qwen3-30B-A3B MoE: 30B quality at 3.3B speed (19GB only!)
// DeepSeek-R1 for reasoning tasks
// MiniCPM-V for best screen vision
// 50% RAM rule enforced

// ── MODEL REGISTRY ─────────────────────────────────────────
const MODELS = {

  // ══ TINY (≤4GB RAM) ═══════════════════════════════════════

  qwen35_08b: {
    ollamaId:    "qwen3.5:0.8b",
    name:        "Qwen 3.5 0.8B",
    sizeGB:      0.5,
    minRAMGB:    2,
    quality:     2.5,
    speed:       5,
    description: "Lightest model — basic app & file tasks, surprisingly capable",
    icon:        "🪶",
    tags:        ["coding", "daily"],
  },

  qwen35_2b: {
    ollamaId:    "qwen3.5:2b",
    name:        "Qwen 3.5 2B",
    sizeGB:      1.5,
    minRAMGB:    3,
    quality:     3.2,
    speed:       5,
    description: "Fast & smart — good JSON, instruction following, basic coding",
    icon:        "⚡",
    tags:        ["coding", "daily"],
  },

  // ══ SMALL (8GB RAM) ═══════════════════════════════════════

  qwen35_4b: {
    ollamaId:    "qwen3.5:4b",
    name:        "Qwen 3.5 4B",
    sizeGB:      2.5,
    minRAMGB:    4,
    quality:     3.8,
    speed:       5,
    description: "Native thinking mode, 256K context — best 4B for coding & PC tasks",
    icon:        "⚡",
    tags:        ["coding", "daily", "thinking"],
  },

  phi4_mini: {
    ollamaId:    "phi4-mini",
    name:        "Phi-4 Mini 3.8B",
    sizeGB:      2.5,
    minRAMGB:    4,
    quality:     3.9,
    speed:       4.5,
    description: "Microsoft's best small — 70% HumanEval, great reasoning & math",
    icon:        "⚡",
    tags:        ["coding", "reasoning", "daily"],
  },

  qwen35_9b: {
    ollamaId:    "qwen3.5:9b",
    name:        "Qwen 3.5 9B",
    sizeGB:      6.0,
    minRAMGB:    8,
    quality:     4.3,
    speed:       3.5,
    description: "Best value mid-tier — 6-8GB, excellent coding & task execution",
    icon:        "⭐",
    tags:        ["coding", "daily", "thinking"],
  },

  deepseek_r1_8b: {
    ollamaId:    "deepseek-r1:8b",
    name:        "DeepSeek R1 8B",
    sizeGB:      4.7,
    minRAMGB:    8,
    quality:     4.2,
    speed:       3.5,
    description: "Chain-of-thought reasoning — best for debugging & complex logic",
    icon:        "🧠",
    tags:        ["reasoning", "coding", "daily"],
  },

  // ══ MEDIUM (16GB RAM) ══════════════════════════════════════

  qwen25_coder_14b: {
    ollamaId:    "qwen2.5-coder:14b",
    name:        "Qwen 2.5 Coder 14B",
    sizeGB:      9.0,
    minRAMGB:    12,
    quality:     4.6,
    speed:       3.0,
    description: "Dedicated coding model — best for writing & reviewing complex code",
    icon:        "💻",
    tags:        ["coding", "daily"],
  },

  qwen35_14b: {
    ollamaId:    "qwen3.5:14b",
    name:        "Qwen 3.5 14B",
    sizeGB:      9.0,
    minRAMGB:    12,
    quality:     4.6,
    speed:       3.0,
    description: "Powerful all-rounder — coding, writing, PC control, 262K context",
    icon:        "🔥",
    tags:        ["coding", "daily", "thinking"],
  },

  deepseek_r1_14b: {
    ollamaId:    "deepseek-r1:14b",
    name:        "DeepSeek R1 14B",
    sizeGB:      9.0,
    minRAMGB:    12,
    quality:     4.6,
    speed:       2.8,
    description: "Elite reasoning — chain-of-thought, complex multi-step tasks",
    icon:        "🧠",
    tags:        ["reasoning", "coding"],
  },

  // ══ LARGE (32GB RAM) ═══════════════════════════════════════

  qwen35_27b: {
    ollamaId:    "qwen3.5:27b",
    name:        "Qwen 3.5 27B",
    sizeGB:      16.0,
    minRAMGB:    20,
    quality:     4.8,
    speed:       2.5,
    description: "Best dense coder — 77.2% SWE-bench, rivals GPT-4 on coding tasks",
    icon:        "🔥",
    tags:        ["coding", "daily", "thinking"],
  },

  // ★ STAR MODEL: MoE magic — 30B quality at 3.3B speed!
  qwen3_30b_moe: {
    ollamaId:    "qwen3:30b-a3b",
    name:        "Qwen 3 30B MoE",
    sizeGB:      19.0,
    minRAMGB:    22,
    quality:     4.9,
    speed:       4.0, // fast because only 3.3B active params!
    description: "⚡ MoE magic — 30B quality at 3.3B speed! Best all-rounder for 32GB",
    icon:        "🌟",
    tags:        ["coding", "daily", "thinking", "moe"],
  },

  // ★ STAR MODEL: Best local coder under 20GB
  qwen3_coder_30b: {
    ollamaId:    "qwen3-coder:30b",
    name:        "Qwen 3 Coder 30B",
    sizeGB:      19.0,
    minRAMGB:    22,
    quality:     5.0,
    speed:       4.0, // MoE — fast!
    description: "Best local coding model 2026 — 256K context, beats Claude Sonnet on many tasks",
    icon:        "💻🌟",
    tags:        ["coding", "agentic", "thinking", "moe"],
  },

  deepseek_r1_32b: {
    ollamaId:    "deepseek-r1:32b",
    name:        "DeepSeek R1 32B",
    sizeGB:      19.0,
    minRAMGB:    22,
    quality:     4.9,
    speed:       2.0,
    description: "World-class reasoning — math, complex logic, chain-of-thought",
    icon:        "🧠",
    tags:        ["reasoning", "coding"],
  },

  // ══ XL (64GB RAM) ══════════════════════════════════════════

  llama33_70b_q3: {
    ollamaId:    "llama3.3:70b-instruct-q3_K_M",
    name:        "Llama 3.3 70B Q3",
    sizeGB:      29.0,
    minRAMGB:    32,
    quality:     4.8,
    speed:       1.5,
    description: "Meta's best large — excellent for all tasks, GPT-4 level quality",
    icon:        "⭐",
    tags:        ["coding", "daily"],
  },

  llama33_70b_q4: {
    ollamaId:    "llama3.3:70b-instruct-q4_K_M",
    name:        "Llama 3.3 70B Q4",
    sizeGB:      40.0,
    minRAMGB:    48,
    quality:     4.9,
    speed:       1.5,
    description: "Professional grade — matches GPT-4 Turbo, best for agencies",
    icon:        "🔥",
    tags:        ["coding", "daily"],
  },

  deepseek_r1_70b: {
    ollamaId:    "deepseek-r1:70b",
    name:        "DeepSeek R1 70B",
    sizeGB:      42.0,
    minRAMGB:    48,
    quality:     5.0,
    speed:       1.2,
    description: "Elite reasoning at scale — complex agentic tasks, rivals o1",
    icon:        "🧠",
    tags:        ["reasoning", "coding"],
  },

  // ══ ULTRA (128GB RAM) ══════════════════════════════════════

  llama33_70b_q8: {
    ollamaId:    "llama3.3:70b-instruct-q8_0",
    name:        "Llama 3.3 70B Q8",
    sizeGB:      75.0,
    minRAMGB:    80,
    quality:     5.0,
    speed:       1.0,
    description: "Maximum 70B quality — absolute best for 128GB systems",
    icon:        "👑",
    tags:        ["coding", "daily"],
  },

  llama31_405b_q2: {
    ollamaId:    "llama3.1:405b-instruct-q2_K",
    name:        "Llama 3.1 405B Q2",
    sizeGB:      108.0,
    minRAMGB:    112,
    quality:     5.0,
    speed:       0.5,
    description: "World class — beats GPT-4 on most benchmarks, 128GB+ only",
    icon:        "👑",
    tags:        ["coding", "daily"],
  },

  // ══ VISION MODELS ══════════════════════════════════════════

  minicpm_v: {
    ollamaId:    "minicpm-v:latest",
    name:        "MiniCPM-V Vision",
    sizeGB:      2.5,
    minRAMGB:    4,
    quality:     4.2,
    speed:       4,
    description: "Best screen reader — OCR, UI understanding, perfect for PC control",
    icon:        "👁️",
    visionOnly:  true,
  },

  gemma4_e4b: {
    ollamaId:    "gemma4:4b",
    name:        "Gemma 4 E4B Vision",
    sizeGB:      3.5,
    minRAMGB:    6,
    quality:     4.0,
    speed:       4.5,
    description: "Google's multimodal — fast screen understanding, 128K context",
    icon:        "👁️",
    visionOnly:  true,
  },

  llava_llama31: {
    ollamaId:    "llava:llama3.1",
    name:        "LLaVA Llama 3.1",
    sizeGB:      5.5,
    minRAMGB:    8,
    quality:     4.3,
    speed:       3.0,
    description: "Powerful vision — excellent for complex UI & screenshot analysis",
    icon:        "👁️",
    visionOnly:  true,
  },

  llava_llama31_q6: {
    ollamaId:    "llava:llama3.1-q6_K",
    name:        "LLaVA Llama 3.1 Q6",
    sizeGB:      7.2,
    minRAMGB:    10,
    quality:     4.6,
    speed:       2.5,
    description: "High quality vision — best screen understanding for Pro+ plans",
    icon:        "👁️",
    visionOnly:  true,
  },
};

// ── PLAN CONFIGS ───────────────────────────────────────────
const PLAN_CONFIGS = {

  // ── FREE ($0) ─────────────────────────────────────────────
  // No vision — user brings no key, just basic tasks
  free: {
    visionAllowed: false,
    visionAuto:    false,
    taskLimit:     50,
    getOptions: (ramGB) => {
      if (ramGB < 4) {
        return [
          { ...MODELS.qwen35_08b, tag: "Only Option", recommended: true },
        ];
      } else if (ramGB < 8) {
        return [
          { ...MODELS.qwen35_08b, tag: "Lightweight" },
          { ...MODELS.qwen35_2b,  tag: "Recommended", recommended: true },
          { ...MODELS.qwen35_4b,  tag: "Best Quality" },
        ];
      } else if (ramGB < 16) {
        return [
          { ...MODELS.qwen35_2b,  tag: "Fastest" },
          { ...MODELS.qwen35_4b,  tag: "Recommended", recommended: true },
          { ...MODELS.phi4_mini,  tag: "Best Reasoning" },
        ];
      } else {
        return [
          { ...MODELS.qwen35_4b,  tag: "Fast" },
          { ...MODELS.phi4_mini,  tag: "Recommended", recommended: true },
          { ...MODELS.qwen35_9b,  tag: "Best Quality" },
        ];
      }
    },
    visionOptions: () => null,
  },

  // ── STARTER ($5) ──────────────────────────────────────────
  // Vision optional — user brings own key
  // Better models than free
  starter: {
    visionAllowed: true,
    visionAuto:    false,
    taskLimit:     250,
    getOptions: (ramGB) => {
      if (ramGB < 8) {
        return [
          { ...MODELS.qwen35_2b,       tag: "Fastest" },
          { ...MODELS.qwen35_4b,       tag: "Recommended", recommended: true },
          { ...MODELS.phi4_mini,       tag: "Best Reasoning" },
        ];
      } else if (ramGB < 16) {
        return [
          { ...MODELS.qwen35_4b,       tag: "Fast" },
          { ...MODELS.qwen35_9b,       tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_8b,  tag: "Best Reasoning" },
        ];
      } else if (ramGB < 28) {
        return [
          { ...MODELS.qwen35_9b,       tag: "Fast" },
          { ...MODELS.qwen25_coder_14b,tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_14b, tag: "Best Reasoning" },
        ];
      } else {
        return [
          { ...MODELS.qwen25_coder_14b,tag: "Fast" },
          { ...MODELS.qwen35_14b,      tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_14b, tag: "Best Reasoning" },
        ];
      }
    },
    visionOptions: (ramGB) => {
      if (ramGB < 8)  return MODELS.minicpm_v;
      return MODELS.gemma4_e4b;
    },
  },

  // ── PRO ($29) ─────────────────────────────────────────────
  // Vision optional — our backend keys
  // Qwen3-Coder / Qwen3-30B MoE for 32GB+ users
  pro: {
    visionAllowed: true,
    visionAuto:    false,
    taskLimit:     500,
    getOptions: (ramGB) => {
      if (ramGB < 12) {
        return [
          { ...MODELS.qwen35_9b,       tag: "Fast" },
          { ...MODELS.qwen25_coder_14b,tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_8b,  tag: "Best Reasoning" },
        ];
      } else if (ramGB < 22) {
        return [
          { ...MODELS.qwen35_9b,       tag: "Fast" },
          { ...MODELS.qwen35_14b,      tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_14b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 40) {
        // ★ Star tier — Qwen3-30B MoE fits here!
        return [
          { ...MODELS.qwen35_14b,      tag: "Fast" },
          { ...MODELS.qwen3_30b_moe,   tag: "Recommended ⭐", recommended: true },
          { ...MODELS.deepseek_r1_32b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 64) {
        return [
          { ...MODELS.qwen3_30b_moe,   tag: "Fast & Smart ⭐", recommended: true },
          { ...MODELS.qwen3_coder_30b, tag: "Best for Coding" },
          { ...MODELS.llama33_70b_q3,  tag: "Largest Option" },
        ];
      } else {
        return [
          { ...MODELS.qwen3_coder_30b, tag: "Best Coder" },
          { ...MODELS.llama33_70b_q3,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      }
    },
    visionOptions: (ramGB) => {
      if (ramGB < 12) return MODELS.minicpm_v;
      if (ramGB < 20) return MODELS.gemma4_e4b;
      return MODELS.llava_llama31;
    },
  },

  // ── PRO MAX ($60) ─────────────────────────────────────────
  // Same as Pro but minimum quality bumped up
  pro_max: {
    visionAllowed: true,
    visionAuto:    false,
    taskLimit:     1250,
    getOptions: (ramGB) => {
      if (ramGB < 16) {
        return [
          { ...MODELS.qwen35_9b,       tag: "Fast" },
          { ...MODELS.qwen25_coder_14b,tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_14b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 28) {
        return [
          { ...MODELS.qwen35_14b,      tag: "Fast" },
          { ...MODELS.deepseek_r1_14b, tag: "Recommended", recommended: true },
          { ...MODELS.qwen35_27b,      tag: "Best Quality" },
        ];
      } else if (ramGB < 50) {
        return [
          { ...MODELS.qwen35_27b,      tag: "Fast" },
          { ...MODELS.qwen3_30b_moe,   tag: "Recommended ⭐", recommended: true },
          { ...MODELS.qwen3_coder_30b, tag: "Best for Coding" },
        ];
      } else if (ramGB < 80) {
        return [
          { ...MODELS.qwen3_coder_30b, tag: "Best Coder" },
          { ...MODELS.llama33_70b_q3,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else {
        return [
          { ...MODELS.llama33_70b_q3,  tag: "Fast" },
          { ...MODELS.llama33_70b_q4,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      }
    },
    visionOptions: (ramGB) => {
      if (ramGB < 16) return MODELS.gemma4_e4b;
      return MODELS.llava_llama31;
    },
  },

  // ── ELITE ($499) ──────────────────────────────────────────
  // Vision auto-ON — best models per RAM
  elite: {
    visionAllowed: true,
    visionAuto:    true,
    taskLimit:     5000,
    getOptions: (ramGB) => {
      if (ramGB < 28) {
        return [
          { ...MODELS.qwen35_14b,      tag: "Fast" },
          { ...MODELS.qwen3_30b_moe,   tag: "Recommended ⭐", recommended: true },
          { ...MODELS.deepseek_r1_14b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 50) {
        return [
          { ...MODELS.qwen3_30b_moe,   tag: "Fast ⭐" },
          { ...MODELS.qwen3_coder_30b, tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_32b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 80) {
        return [
          { ...MODELS.qwen3_coder_30b, tag: "Best Coder" },
          { ...MODELS.llama33_70b_q3,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 120) {
        return [
          { ...MODELS.llama33_70b_q3,  tag: "Fast" },
          { ...MODELS.llama33_70b_q4,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else {
        return [
          { ...MODELS.llama33_70b_q4,  tag: "Fast" },
          { ...MODELS.llama33_70b_q8,  tag: "Recommended", recommended: true },
          { ...MODELS.llama31_405b_q2, tag: "World Class 👑" },
        ];
      }
    },
    visionOptions: (ramGB) => {
      if (ramGB < 16) return MODELS.gemma4_e4b;
      if (ramGB < 24) return MODELS.llava_llama31;
      return MODELS.llava_llama31_q6;
    },
  },

  // ── ELITE ULTRA ($999) ────────────────────────────────────
  // No limit, vision auto, best possible always
  elite_ultra: {
    visionAllowed: true,
    visionAuto:    true,
    taskLimit:     Infinity,
    getOptions: (ramGB) => {
      if (ramGB < 32) {
        return [
          { ...MODELS.qwen3_30b_moe,   tag: "Fast ⭐" },
          { ...MODELS.qwen3_coder_30b, tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_32b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 64) {
        return [
          { ...MODELS.qwen3_coder_30b, tag: "Best Coder" },
          { ...MODELS.llama33_70b_q3,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 120) {
        return [
          { ...MODELS.llama33_70b_q4,  tag: "Fast" },
          { ...MODELS.llama33_70b_q8,  tag: "Recommended", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else if (ramGB < 250) {
        return [
          { ...MODELS.llama33_70b_q8,  tag: "Fast" },
          { ...MODELS.llama31_405b_q2, tag: "Recommended 👑", recommended: true },
          { ...MODELS.deepseek_r1_70b, tag: "Best Reasoning" },
        ];
      } else {
        return [
          { ...MODELS.llama31_405b_q2, tag: "Fast 👑" },
          { ...MODELS.llama31_405b_q2, tag: "Recommended 👑", recommended: true },
          { ...MODELS.llama33_70b_q8,  tag: "Fast Option" },
        ];
      }
    },
    visionOptions: () => MODELS.llava_llama31_q6,
  },
};

// ── MAIN: 50% RAM Rule enforced ────────────────────────────
function getModelOptions(plan, specs) {
  const config = PLAN_CONFIGS[plan] || PLAN_CONFIGS["free"];
  const ramGB  = specs.ramGB          || 8;
  const freeGB = specs.freeStorageGB  || 50;

  // 50% RAM rule: model must use ≤50% total RAM
  // Keeps PC smooth while agent runs
  const maxModelSizeGB = Math.floor(ramGB * 0.50);

  const options     = config.getOptions(ramGB);
  const visionModel = config.visionAllowed ? config.visionOptions?.(ramGB) : null;

  // Filter: ≤50% RAM + enough disk
  let filtered = options.filter(m =>
    m.sizeGB <= maxModelSizeGB &&
    m.sizeGB <= freeGB - 2
  );

  // Fallback if nothing fits 50% rule
  if (filtered.length === 0) {
    const sorted   = [...options].sort((a, b) => a.sizeGB - b.sizeGB);
    const smallest = sorted.find(m => m.sizeGB <= freeGB - 2) || sorted[0];
    filtered = [{ ...smallest, tag: "Best Available", recommended: true }];
  }

  // Max 3 shown
  const finalOptions = filtered.slice(0, 3);

  // Re-mark recommended = highest quality that fits
  finalOptions.forEach(m => { m.recommended = false; });
  const best = [...finalOptions].sort((a, b) => b.quality - a.quality)[0];
  if (best) best.recommended = true;

  // Vision: must also fit in remaining RAM (45% of leftover)
  let finalVision = null;
  if (visionModel && config.visionAllowed) {
    const mainSize      = best?.sizeGB || 0;
    const remainRAM     = ramGB - mainSize;
    const fitsRAM       = visionModel.sizeGB <= remainRAM * 0.45;
    const fitsDisk      = visionModel.sizeGB <= freeGB - mainSize - 2;

    if (fitsRAM && fitsDisk) {
      finalVision = visionModel;
    } else {
      // Try MiniCPM-V as lightweight fallback
      const mini     = MODELS.minicpm_v;
      const miniFits = mini.sizeGB <= remainRAM * 0.45 && mini.sizeGB <= freeGB - mainSize - 2;
      if (miniFits) finalVision = mini;
    }
  }

  return {
    models:         finalOptions,
    visionModel:    finalVision,
    visionAllowed:  config.visionAllowed && !!finalVision,
    visionAuto:     config.visionAuto,
    taskLimit:      config.taskLimit,
    maxModelSizeGB,
    ramGB,
    plan,
  };
}

module.exports = { getModelOptions, MODELS, PLAN_CONFIGS };