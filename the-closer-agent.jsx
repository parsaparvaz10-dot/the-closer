import { useState, useCallback } from "react";

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-20250514";
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const API_TIMEOUT_MS = 120000; // 2 minutes per step

// ─── AGENT STEP DEFINITIONS ─────────────────────────────────────────────────
const STEPS = [
  { id: "intel", label: "Property Intel", icon: "🔍", desc: "Gathering property data, tax records, and neighborhood context" },
  { id: "comps", label: "Comp Analysis", icon: "📊", desc: "Finding and analyzing comparable sales" },
  { id: "condition", label: "Condition & Risk", icon: "🏚️", desc: "Assessing property condition, flood zone, and environmental risk" },
  { id: "rehab", label: "Rehab & Costs", icon: "🔧", desc: "Estimating rehab scope and costs across three scenarios" },
  { id: "financials", label: "Deal Scoring", icon: "💰", desc: "Modeling profit scenarios and computing final deal score" },
];

// ─── SYSTEM PROMPTS PER STEP ─────────────────────────────────────────────────

const PROMPT_INTEL = `You are The Closer's Property Intelligence Agent. Your ONLY job is to research a property and return structured data.

Given a property address and any provided details, use web search aggressively to find:
- Full property details (sqft, beds, baths, year built, lot size, stories)
- Current tax appraisal value and tax history
- Ownership history and current listing status
- Neighborhood context (median home price, school ratings, crime trends, development)
- Days on market if currently listed
- Any prior sales history with prices and dates
- Zoning information

CRITICAL RULES:
1. Search for the EXACT address on Zillow, Redfin, HAR.com, and county tax records
2. If you can't find a specific data point, estimate based on neighborhood averages and FLAG it as estimated
3. Return ONLY valid JSON — no markdown, no backticks, no explanation
4. All string values must use double quotes and escape any internal quotes with backslash

Return this exact JSON structure:
{
  "address": "full address",
  "propertyDetails": {
    "sqft": number or null,
    "sqftSource": "verified" or "estimated",
    "beds": number or null,
    "baths": number or null,
    "yearBuilt": number or null,
    "lotSizeSqft": number or null,
    "stories": number or null,
    "propertyType": "string",
    "garage": "string or null"
  },
  "taxData": {
    "appraisalValue": number or null,
    "annualTaxes": number or null,
    "taxYear": number or null
  },
  "ownershipHistory": [{"date": "string", "price": number or null, "event": "string"}],
  "listingStatus": "active/pending/sold/off-market/unknown",
  "daysOnMarket": number or null,
  "neighborhood": {
    "medianHomePrice": number or null,
    "medianPricePerSqft": number or null,
    "schoolRating": "string or null",
    "crimeLevel": "low/moderate/high/unknown",
    "trendDirection": "appreciating/stable/declining/unknown",
    "notableContext": "string — any relevant neighborhood info"
  },
  "dataConfidence": "high/medium/low",
  "searchNotes": "string — what you found, what you couldn't find, what's estimated"
}`;

const PROMPT_COMPS = (intel, knownComps) => `You are The Closer's Comparable Sales Analyst. Your job is to find and analyze comparable sales to establish ARV.

SUBJECT PROPERTY DATA (from previous research):
${JSON.stringify(intel, null, 2)}

${knownComps ? `USER-PROVIDED KNOWN COMPS (treat these as verified, high-weight comps):
${knownComps}` : "No known comps provided by user."}

COMP SELECTION RULES:
- Search for SOLD properties within 1 mile (tighten to 0.5mi in dense areas)
- Sold within last 6 months (extend to 9 if thin inventory)
- Same bed/bath count +/- 1 (hard constraint)
- Square footage within +/- 20%
- Prioritize RENOVATED comps for ARV estimation
- Include AS-IS comps for acquisition price validation
- Target 5-8 comps, minimum 3
- Search on Zillow, Redfin, HAR.com, Realtor.com

USE WEB SEARCH to find actual recent sales near this property. Search for:
1. "[neighborhood] recently sold homes [beds]bed"
2. "[zip code] sold homes last 6 months"
3. "[street name area] comparable sales"
4. Specific addresses if known comps are provided

CRITICAL: Search multiple times with different queries to find the best comps.
All string values must use double quotes and escape any internal quotes with backslash.

Return ONLY valid JSON:
{
  "comps": [
    {
      "address": "string",
      "salePrice": number,
      "saleDate": "string",
      "sqft": number,
      "pricePerSqft": number,
      "beds": number,
      "baths": number,
      "yearBuilt": number or null,
      "condition": "renovated/updated/average/dated/distressed",
      "distanceMiles": number,
      "source": "string — where you found this comp",
      "relevanceScore": 1-10,
      "notes": "string"
    }
  ],
  "arvAnalysis": {
    "arvLow": number,
    "arvExpected": number,
    "arvHigh": number,
    "medianPricePerSqft": number,
    "renovatedPricePerSqft": number,
    "compConfidence": 1-10,
    "confidenceReason": "string"
  },
  "marketContext": {
    "inventoryLevel": "low/moderate/high",
    "avgDaysOnMarket": number or null,
    "priceDirection": "rising/stable/falling",
    "buyerDemand": "strong/moderate/weak"
  },
  "searchNotes": "string — what searches you ran, what you found"
}`;

const PROMPT_CONDITION = (intel, comps) => `You are The Closer's Property Condition & Risk Assessment Agent.

SUBJECT PROPERTY DATA:
${JSON.stringify(intel, null, 2)}

COMP DATA FOR CONTEXT:
${JSON.stringify(comps?.arvAnalysis || {}, null, 2)}

Assess the property across 9 building systems and evaluate Houston-specific risks.
Use web search to check:
1. FEMA flood zone for this exact address
2. Harvey flood damage records for this area
3. Harris County Flood Control District data
4. Proximity to bayous or detention basins
5. Houston soil zone (Beaumont clay areas)

HOUSTON-SPECIFIC KNOWLEDGE:
- Expansive Beaumont clay = high foundation risk
- Galvanized/polybutylene pipes in pre-1990 homes = repipe likely
- Federal Pacific/Zinsco panels = replacement mandatory
- Flat roofs + Houston heat = shorter roof life
- Year-round AC demand = HVAC wears faster
- Properties near Brays Bayou, Buffalo Bayou, White Oak Bayou, Greens Bayou = elevated flood risk regardless of FEMA zone

All string values must use double quotes and escape any internal quotes with backslash.

Return ONLY valid JSON:
{
  "conditionAssessment": {
    "overallGrade": "A/B/C/D/F",
    "classification": "Renovated/Dated-but-functional/Cosmetic-rehab/Heavy-rehab/Gut-job",
    "systems": [
      {
        "name": "Roof/Foundation/HVAC/Plumbing/Electrical/Interior/Exterior/Kitchen/Bathrooms",
        "status": "Good/Fair/Poor/Critical",
        "notes": "string",
        "estimatedAge": "string or null",
        "houstonFlag": "string or null"
      }
    ]
  },
  "floodRisk": {
    "overallRisk": "LOW/MODERATE/HIGH/CRITICAL",
    "femaZone": "string",
    "harveyImpact": "none/minor/moderate/severe/unknown",
    "bayouProximity": "string",
    "drainageRisk": "string",
    "insuranceEstimate": number or null,
    "factors": [
      {"factor": "string", "risk": "LOW/MODERATE/HIGH", "details": "string"}
    ]
  },
  "dealKillers": ["string — any absolute deal-killer findings"],
  "searchNotes": "string"
}`;

const PROMPT_REHAB = (intel, comps, condition, finishLevel) => `You are The Closer's Rehab Cost Estimation Agent for Houston, TX.

PROPERTY DATA:
${JSON.stringify(intel?.propertyDetails || {}, null, 2)}

ARV TARGET: ${JSON.stringify(comps?.arvAnalysis || {}, null, 2)}

CONDITION ASSESSMENT:
${JSON.stringify(condition?.conditionAssessment || {}, null, 2)}

TARGET FINISH LEVEL: ${finishLevel || "Standard flip — match neighborhood expectations"}

HOUSTON CONTRACTOR PRICING (2024-2025 actual rates — DO NOT use national averages):
- Foundation repair: $4,000-$12,000 (depends on piers needed)
- Roof replacement: $8,000-$15,000 (dimensional shingle; metal adds $5-8K)
- Full kitchen reno: $12,000-$25,000
- Bathroom reno (each): $5,000-$12,000
- Interior paint (full): $3,000-$6,000
- Flooring full house (LVP): $5,000-$12,000
- HVAC replacement: $5,000-$9,000
- Full re-pipe (PEX): $4,000-$8,000
- Electrical panel upgrade: $2,000-$4,500
- Exterior paint: $3,000-$6,000
- Landscaping: $1,500-$4,000
- Driveway: $2,000-$6,000
- Dumpster + cleanup: $1,500-$3,000
- Permits: $500-$2,500

Generate three rehab scenarios based on condition assessment findings.
All string values must use double quotes and escape any internal quotes with backslash.

Return ONLY valid JSON:
{
  "scenarios": {
    "conservative": {
      "label": "Cosmetic Only",
      "scope": "string — what's included",
      "totalLow": number,
      "totalHigh": number,
      "totalExpected": number,
      "lineItems": [{"item": "string", "low": number, "high": number, "expected": number, "rationale": "string"}],
      "timelineWeeks": number
    },
    "expected": {
      "label": "Standard Flip",
      "scope": "string",
      "totalLow": number,
      "totalHigh": number,
      "totalExpected": number,
      "lineItems": [{"item": "string", "low": number, "high": number, "expected": number, "rationale": "string"}],
      "timelineWeeks": number
    },
    "aggressive": {
      "label": "Full Scope",
      "scope": "string",
      "totalLow": number,
      "totalHigh": number,
      "totalExpected": number,
      "lineItems": [{"item": "string", "low": number, "high": number, "expected": number, "rationale": "string"}],
      "timelineWeeks": number
    }
  },
  "criticalItems": ["string — items that MUST be addressed regardless of scenario"],
  "notes": "string"
}`;

const PROMPT_FINANCIALS = (intel, comps, condition, rehab, askingPrice, financing) => `You are The Closer's Deal Scoring & Financial Analysis Agent.

ASKING PRICE: $${askingPrice}

FINANCING TERMS: ${financing || "Hard money at 12% APR, 90% LTC, 2 points origination"}

ARV ANALYSIS:
${JSON.stringify(comps?.arvAnalysis || {}, null, 2)}

MARKET CONTEXT:
${JSON.stringify(comps?.marketContext || {}, null, 2)}

CONDITION GRADE: ${condition?.conditionAssessment?.overallGrade || "Unknown"}
FLOOD RISK: ${condition?.floodRisk?.overallRisk || "Unknown"}
DEAL KILLERS: ${JSON.stringify(condition?.dealKillers || [])}

REHAB ESTIMATES:
Conservative: $${rehab?.scenarios?.conservative?.totalExpected || "Unknown"}
Expected: $${rehab?.scenarios?.expected?.totalExpected || "Unknown"}
Aggressive: $${rehab?.scenarios?.aggressive?.totalExpected || "Unknown"}

FINANCIAL MODEL RULES:
- Hold period: 5 months
- Holding costs: $2,500-4,000/month (loan payment + insurance + taxes + utilities)
- Buy-side closing: 2-3% of acquisition
- Sell-side closing: 6-8% of ARV (commissions + title + concessions)
- Minimum acceptable ROI: 15%
- Target ROI: 25-30%

MODEL THREE SCENARIOS:
1. Best case: Conservative rehab + Expected ARV
2. Base case: Expected rehab + Expected ARV
3. Worst case: Aggressive rehab + Low ARV

IMPORTANT: The profitScenarios array MUST be ordered: [Best Case, Base Case, Worst Case] at indices 0, 1, 2.

DEAL SCORE (1-100):
- Profit potential: 40% weight (base case ROI > 30% = high, < 10% = low, negative = near zero)
- Risk level: 30% weight (flood, comp confidence, condition severity, neighborhood)
- Market conditions: 30% weight (DOM, inventory, demand, appreciation)

VERDICT RULES (strictly follow these score thresholds):
- BUY = dealScore 85-100 (only for high-conviction deals with strong margins and manageable risk)
- NEGOTIATE = dealScore 45-84 (deal has potential but needs a better price or risk mitigation)
- PASS = dealScore 0-44 (numbers don't work or risk is too high)

All string values must use double quotes and escape any internal quotes with backslash.

Return ONLY valid JSON:
{
  "profitScenarios": [
    {
      "name": "Best Case",
      "arvUsed": number,
      "rehabCost": number,
      "acquisitionCost": number,
      "holdingCosts": number,
      "buyClosing": number,
      "sellClosing": number,
      "totalInvested": number,
      "grossProfit": number,
      "netProfit": number,
      "roi": number,
      "margin": number
    },
    {
      "name": "Base Case",
      "arvUsed": number,
      "rehabCost": number,
      "acquisitionCost": number,
      "holdingCosts": number,
      "buyClosing": number,
      "sellClosing": number,
      "totalInvested": number,
      "grossProfit": number,
      "netProfit": number,
      "roi": number,
      "margin": number
    },
    {
      "name": "Worst Case",
      "arvUsed": number,
      "rehabCost": number,
      "acquisitionCost": number,
      "holdingCosts": number,
      "buyClosing": number,
      "sellClosing": number,
      "totalInvested": number,
      "grossProfit": number,
      "netProfit": number,
      "roi": number,
      "margin": number
    }
  ],
  "dealScore": number (1-100),
  "verdict": "BUY/NEGOTIATE/PASS",
  "verdictReason": "string",
  "negotiation": {
    "openingOffer": number,
    "maxOffer": number,
    "walkaway": number,
    "tactics": "string — specific negotiation advice for this deal"
  },
  "closerTake": "string — 2-3 sentences of unfiltered dealmaker commentary. Be direct. If it is a dog, say it is a dog. If it is a gem, say why.",
  "riskFactors": ["string"],
  "strengths": ["string"]
}`;


// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Sanitize user-entered dollar amounts: strip $, commas, spaces → pure number string */
function sanitizePrice(val) {
  if (!val) return "0";
  const cleaned = String(val).replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? "0" : String(Math.round(num));
}

/** Sleep helper for retry backoff */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract and parse JSON from an API response string. Handles markdown fences, 
 *  trailing commas, and malformed control characters without corrupting apostrophes. */
function extractJSON(raw) {
  // Strip markdown code fences
  let cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  // Find the outermost JSON object
  // BUG FIX: Use brace-depth counting instead of greedy regex to avoid grabbing
  // unrelated braces in surrounding text
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{" && start === -1) {
      start = i;
      depth = 1;
    } else if (ch === "{" && start !== -1) {
      depth++;
    } else if (ch === "}" && start !== -1) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    // Skip over string literals to avoid counting braces inside strings
    if (ch === '"' && start !== -1 && i > start) {
      let j = i + 1;
      while (j < cleaned.length && cleaned[j] !== '"') {
        if (cleaned[j] === "\\") j++; // skip escaped characters
        j++;
      }
      i = j; // advance past closing quote
    }
  }

  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in API response");
  }

  const jsonStr = cleaned.substring(start, end + 1);

  // First attempt: parse as-is
  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    // Fall through to repair
  }

  // Repair pass — fix common LLM JSON mistakes WITHOUT corrupting string content
  let repaired = jsonStr
    // Fix trailing commas before } or ]
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    // Remove non-printable control chars EXCEPT valid whitespace (\n, \t, \r, space)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // BUG FIX: Do NOT blindly replace single quotes with double quotes.
  // The original code had: .replace(/'/g, '"')
  // This corrupts strings like "There's a crack" → "There"s a crack" → invalid JSON.
  // Instead, only replace single-quoted keys/values at JSON structural boundaries.

  try {
    return JSON.parse(repaired);
  } catch (_) {
    // Fall through to deeper repair
  }

  // Deeper repair: try to fix unescaped newlines inside string values
  // Replace literal newlines inside JSON strings with \\n
  let inString = false;
  let result = "";
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (ch === '"' && (i === 0 || repaired[i - 1] !== "\\")) {
      inString = !inString;
      result += ch;
    } else if (inString && ch === "\n") {
      result += "\\n";
    } else if (inString && ch === "\t") {
      result += "\\t";
    } else {
      result += ch;
    }
  }

  try {
    return JSON.parse(result);
  } catch (e) {
    throw new Error(`JSON parse failed after repair: ${e.message}\nFirst 200 chars: ${result.substring(0, 200)}`);
  }
}


// ─── API CALL HELPER ─────────────────────────────────────────────────────────
async function callAgent(systemPrompt, userMessage, useWebSearch = true) {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (useWebSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // BUG FIX: Add timeout so a hung request doesn't spin forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const err = await res.text();
        // Retry on 429 (rate limit) and 529 (overloaded)
        if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
          lastError = new Error(`API ${res.status} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS * (attempt + 1)); // linear backoff
          continue;
        }
        throw new Error(`API error ${res.status}: ${err}`);
      }

      const data = await res.json();
      const textBlocks = data.content?.filter((b) => b.type === "text") || [];
      const raw = textBlocks.map((b) => b.text).join("\n");

      if (!raw.trim()) {
        throw new Error("API returned no text content — the model may have only performed tool use without generating a final answer.");
      }

      // BUG FIX: Use robust JSON extractor instead of greedy regex + broken repair
      return extractJSON(raw);
    } catch (err) {
      lastError = err;
      if (err.name === "AbortError") {
        lastError = new Error(`API call timed out after ${API_TIMEOUT_MS / 1000}s`);
      }
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error("API call failed after retries");
}

// ─── DESIGN TOKENS ──────────────────────────────────────────────────────────
const T = {
  bg: "#0C0F14",
  surface: "#141820",
  surfaceHover: "#1A1F2A",
  border: "rgba(255,255,255,0.06)",
  borderActive: "rgba(255,255,255,0.12)",
  text: "#E8ECF1",
  textMuted: "#7A8494",
  textDim: "#4A5568",
  green: "#22C55E",
  greenDim: "rgba(34,197,94,0.12)",
  amber: "#F59E0B",
  amberDim: "rgba(245,158,11,0.12)",
  red: "#EF4444",
  redDim: "rgba(239,68,68,0.12)",
  blue: "#3B82F6",
  blueDim: "rgba(59,130,246,0.12)",
  mono: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
  sans: "'Inter', -apple-system, sans-serif",
  radius: "8px",
  radiusLg: "12px",
};

// ─── REUSABLE COMPONENTS ─────────────────────────────────────────────────────
const Card = ({ children, style, ...props }) => (
  <div
    style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.radiusLg,
      padding: "20px",
      ...style,
    }}
    {...props}
  >
    {children}
  </div>
);

const Badge = ({ color = "green", children }) => {
  const colors = {
    green: { bg: T.greenDim, fg: T.green },
    amber: { bg: T.amberDim, fg: T.amber },
    red: { bg: T.redDim, fg: T.red },
    blue: { bg: T.blueDim, fg: T.blue },
  };
  const c = colors[color] || colors.green;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        background: c.bg,
        color: c.fg,
        fontFamily: T.mono,
      }}
    >
      {children}
    </span>
  );
};

const Input = ({ label, required, ...props }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
    <label
      style={{
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        color: T.textMuted,
        fontFamily: T.mono,
      }}
    >
      {label}
      {required && <span style={{ color: T.red, marginLeft: 3 }}>*</span>}
    </label>
    <input
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: "10px 14px",
        color: T.text,
        fontSize: "14px",
        fontFamily: T.sans,
        outline: "none",
        transition: "border-color 0.2s",
      }}
      onFocus={(e) => (e.target.style.borderColor = T.green)}
      onBlur={(e) => (e.target.style.borderColor = T.border)}
      {...props}
    />
  </div>
);

const Textarea = ({ label, ...props }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
    <label
      style={{
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        color: T.textMuted,
        fontFamily: T.mono,
      }}
    >
      {label}
    </label>
    <textarea
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: "10px 14px",
        color: T.text,
        fontSize: "14px",
        fontFamily: T.sans,
        outline: "none",
        resize: "vertical",
        minHeight: "70px",
        transition: "border-color 0.2s",
      }}
      onFocus={(e) => (e.target.style.borderColor = T.green)}
      onBlur={(e) => (e.target.style.borderColor = T.border)}
      {...props}
    />
  </div>
);

const Select = ({ label, options, ...props }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
    <label
      style={{
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.5px",
        textTransform: "uppercase",
        color: T.textMuted,
        fontFamily: T.mono,
      }}
    >
      {label}
    </label>
    <select
      style={{
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: T.radius,
        padding: "10px 14px",
        color: T.text,
        fontSize: "14px",
        fontFamily: T.sans,
        outline: "none",
      }}
      {...props}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
);

// ─── SCORE RING ──────────────────────────────────────────────────────────────
const ScoreRing = ({ score, size = 140 }) => {
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score >= 85 ? T.green : score >= 45 ? T.amber : T.red;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={T.border} strokeWidth="6"
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={`${progress} ${circumference}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 1s ease" }}
      />
      <text x={size / 2} y={size / 2 - 8} textAnchor="middle" fill={color}
        style={{ fontSize: "32px", fontWeight: 700, fontFamily: T.mono }}>
        {score}
      </text>
      <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fill={T.textMuted}
        style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "1px", fontFamily: T.mono }}>
        DEAL SCORE
      </text>
    </svg>
  );
};

// ─── STATUS INDICATOR ────────────────────────────────────────────────────────
const StatusDot = ({ status }) => {
  const colors = { Good: T.green, Fair: T.amber, Poor: T.red, Critical: T.red };
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: colors[status] || T.textMuted,
        marginRight: 8,
        boxShadow: `0 0 6px ${colors[status] || T.textMuted}40`,
      }}
    />
  );
};

// ─── DOLLAR FORMAT ───────────────────────────────────────────────────────────
const fmt = (n) => {
  if (n == null || isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString();
};
const pct = (n) => {
  if (n == null || isNaN(n)) return "—";
  return n.toFixed(1) + "%";
};

// ─── HELPER: find base-case profit scenario by name, with index fallback ────
function findScenario(scenarios, nameFragment, fallbackIndex) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return null;
  const found = scenarios.find((s) =>
    s.name?.toLowerCase().includes(nameFragment.toLowerCase())
  );
  return found || scenarios[fallbackIndex] || null;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function TheCloser() {
  const [view, setView] = useState("intake"); // intake | running | results
  const [currentStep, setCurrentStep] = useState(0);
  const [stepLogs, setStepLogs] = useState([]);
  const [stepResults, setStepResults] = useState({});
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("summary");

  // Form state
  const [form, setForm] = useState({
    address: "",
    askingPrice: "",
    beds: "",
    baths: "",
    sqft: "",
    yearBuilt: "",
    listingUrl: "",
    notes: "",
    knownComps: "",
    finishLevel: "standard",
    financing: "",
    maxRehab: "",
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const addLog = useCallback((stepIdx, msg) => {
    setStepLogs((prev) => {
      const next = [...prev];
      if (!next[stepIdx]) next[stepIdx] = [];
      next[stepIdx] = [...next[stepIdx], { time: new Date(), msg }];
      return next;
    });
  }, []);

  // ── RUN THE AGENT PIPELINE ──────────────────────────────────────────────
  const runPipeline = async () => {
    setView("running");
    setCurrentStep(0);
    setStepLogs([]);
    setStepResults({});
    setError(null);

    const results = {};
    // BUG FIX: sanitize asking price once — strip $, commas, whitespace
    const cleanPrice = sanitizePrice(form.askingPrice);

    try {
      // STEP 1: Property Intel
      addLog(0, "Searching property records, tax data, and neighborhood context...");
      const intelMsg = [
        `Evaluate this property:`,
        `Address: ${form.address}`,
        form.beds ? `Beds: ${form.beds}` : "",
        form.baths ? `Baths: ${form.baths}` : "",
        form.sqft ? `Sqft: ${form.sqft}` : "",
        form.yearBuilt ? `Year Built: ${form.yearBuilt}` : "",
        form.listingUrl ? `Listing: ${form.listingUrl}` : "",
        form.notes ? `Notes: ${form.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      results.intel = await callAgent(PROMPT_INTEL, intelMsg, true);
      addLog(0, `✓ Found property data — confidence: ${results.intel?.dataConfidence || "unknown"}`);
      setStepResults((prev) => ({ ...prev, intel: results.intel }));
      setCurrentStep(1);

      // STEP 2: Comp Analysis
      addLog(1, "Searching for comparable sales within 1 mile...");
      const compsPrompt = PROMPT_COMPS(results.intel, form.knownComps || null);
      results.comps = await callAgent(compsPrompt, `Find comps for ${form.address}. Asking price: $${cleanPrice}.`, true);
      addLog(1, `✓ Found ${results.comps?.comps?.length || 0} comps — confidence: ${results.comps?.arvAnalysis?.compConfidence || "?"}/10`);
      setStepResults((prev) => ({ ...prev, comps: results.comps }));
      setCurrentStep(2);

      // STEP 3: Condition & Risk
      addLog(2, "Checking FEMA flood zones, Harvey records, and soil data...");
      const condPrompt = PROMPT_CONDITION(results.intel, results.comps);
      results.condition = await callAgent(condPrompt, `Assess condition and risk for ${form.address}, built ${results.intel?.propertyDetails?.yearBuilt || form.yearBuilt || "unknown year"}.`, true);
      addLog(2, `✓ Grade: ${results.condition?.conditionAssessment?.overallGrade || "?"} | Flood: ${results.condition?.floodRisk?.overallRisk || "?"}`);
      setStepResults((prev) => ({ ...prev, condition: results.condition }));
      setCurrentStep(3);

      // STEP 4: Rehab Estimation
      addLog(3, "Calculating rehab costs using Houston contractor pricing...");
      const rehabPrompt = PROMPT_REHAB(results.intel, results.comps, results.condition, form.finishLevel);
      results.rehab = await callAgent(rehabPrompt, `Estimate rehab for ${form.address}. Max budget: ${form.maxRehab ? "$" + sanitizePrice(form.maxRehab) : "no hard cap"}.`, false);
      addLog(3, `✓ Expected rehab: ${fmt(results.rehab?.scenarios?.expected?.totalExpected)}`);
      setStepResults((prev) => ({ ...prev, rehab: results.rehab }));
      setCurrentStep(4);

      // STEP 5: Deal Scoring
      addLog(4, "Modeling profit scenarios and computing deal score...");
      const finPrompt = PROMPT_FINANCIALS(results.intel, results.comps, results.condition, results.rehab, cleanPrice, form.financing);
      results.financials = await callAgent(finPrompt, `Score this deal. Asking: $${cleanPrice}. ARV expected: $${results.comps?.arvAnalysis?.arvExpected}. Expected rehab: $${results.rehab?.scenarios?.expected?.totalExpected}.`, false);
      addLog(4, `✓ Deal Score: ${results.financials?.dealScore} — ${results.financials?.verdict}`);
      setStepResults((prev) => ({ ...prev, financials: results.financials }));

      setView("results");
    } catch (err) {
      console.error(err);
      setError(err.message);
      // BUG FIX: Always sync partial results to state so they can be viewed
      setStepResults((prev) => ({ ...prev, ...results }));
    }
  };

  // ── INTAKE VIEW ─────────────────────────────────────────────────────────
  if (view === "intake") {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: T.sans, padding: "24px" }}>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {/* Header */}
          <div style={{ marginBottom: 32, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: `linear-gradient(135deg, ${T.green}, ${T.green}80)`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 16, fontFamily: T.mono }}>
              $
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.3px" }}>THE CLOSER</div>
              <div style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, letterSpacing: "0.5px" }}>MOTAYO INVESTMENTS · AI DEAL EVALUATION AGENT</div>
            </div>
          </div>

          {/* Property Details */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.green, fontFamily: T.mono, letterSpacing: "0.5px", marginBottom: 16 }}>
              PROPERTY DETAILS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
              <Input label="Property Address" required placeholder="e.g. 1234 Main St, Houston, TX 77004" value={form.address} onChange={set("address")} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <Input label="Asking Price" required placeholder="185000" value={form.askingPrice} onChange={set("askingPrice")} />
                <Input label="Year Built" placeholder="1985" value={form.yearBuilt} onChange={set("yearBuilt")} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <Input label="Beds" placeholder="3" value={form.beds} onChange={set("beds")} />
                <Input label="Baths" placeholder="2" value={form.baths} onChange={set("baths")} />
                <Input label="Sqft" placeholder="1450" value={form.sqft} onChange={set("sqft")} />
              </div>
              <Input label="Listing URL" placeholder="https://har.com/..." value={form.listingUrl} onChange={set("listingUrl")} />
              <Textarea label="Agent / Wholesaler Notes" placeholder="Motivated seller, foundation repair done 2022, new HVAC..." value={form.notes} onChange={set("notes")} />
            </div>
          </Card>

          {/* Deal Parameters */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.amber, fontFamily: T.mono, letterSpacing: "0.5px", marginBottom: 16 }}>
              DEAL PARAMETERS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Select
                label="Target Finish Level"
                options={[
                  { value: "rental", label: "Rental Grade" },
                  { value: "standard", label: "Standard Flip" },
                  { value: "premium", label: "Premium Flip" },
                ]}
                value={form.finishLevel}
                onChange={set("finishLevel")}
              />
              <Input label="Max Rehab Budget" placeholder="65000 (optional)" value={form.maxRehab} onChange={set("maxRehab")} />
            </div>
            <div style={{ marginTop: 14 }}>
              <Textarea label="Financing Terms" placeholder="Hard money at 10%, 2pts, 90% LTC (or leave blank for defaults)" value={form.financing} onChange={set("financing")} />
            </div>
          </Card>

          {/* Known Comps */}
          <Card style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.blue, fontFamily: T.mono, letterSpacing: "0.5px", marginBottom: 16 }}>
              KNOWN COMPS (OPTIONAL)
            </div>
            <Textarea
              label="Paste comp addresses and sale prices you've already identified"
              placeholder={"e.g.\n1240 Oak St — sold $235K, 3/2, 1,500sf, renovated, Feb 2026\n1310 Elm Ave — sold $210K, 3/2, 1,380sf, updated, Dec 2025"}
              value={form.knownComps}
              onChange={set("knownComps")}
              style={{ minHeight: 90 }}
            />
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 8, fontFamily: T.mono }}>
              These anchor the AI's comp analysis with verified data you trust
            </div>
          </Card>

          {/* CTA */}
          <button
            onClick={runPipeline}
            disabled={!form.address || !form.askingPrice}
            style={{
              width: "100%",
              padding: "16px",
              borderRadius: T.radiusLg,
              border: "none",
              background: form.address && form.askingPrice ? `linear-gradient(135deg, ${T.green}, #16a34a)` : T.surfaceHover,
              color: form.address && form.askingPrice ? "#fff" : T.textDim,
              fontSize: "15px",
              fontWeight: 700,
              fontFamily: T.sans,
              cursor: form.address && form.askingPrice ? "pointer" : "not-allowed",
              letterSpacing: "-0.2px",
              transition: "all 0.2s",
            }}
          >
            Run Full Evaluation →
          </button>
          <div style={{ textAlign: "center", fontSize: 11, color: T.textDim, marginTop: 10, fontFamily: T.mono }}>
            5-step agentic pipeline · ~2-4 minutes · web search enabled
          </div>
        </div>
      </div>
    );
  }

  // ── RUNNING VIEW ────────────────────────────────────────────────────────
  if (view === "running") {
    // BUG FIX: Determine if we have enough partial results to allow viewing
    const hasPartialResults = Object.keys(stepResults).length > 0;

    return (
      <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: T.sans, padding: "24px" }}>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Evaluating Deal</div>
            <div style={{ fontSize: 13, color: T.textMuted, fontFamily: T.mono }}>{form.address}</div>
            <div style={{ fontSize: 13, color: T.green, fontFamily: T.mono }}>Asking: ${Number(sanitizePrice(form.askingPrice)).toLocaleString()}</div>
          </div>

          {/* Step progress */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {STEPS.map((step, i) => {
              const isActive = i === currentStep && !error;
              const isDone = i < currentStep || (view === "results");
              const isFailed = i === currentStep && !!error;
              const isPending = i > currentStep;
              const logs = stepLogs[i] || [];

              return (
                <Card
                  key={step.id}
                  style={{
                    borderColor: isFailed ? T.red + "60" : isActive ? T.green + "60" : T.border,
                    opacity: isPending ? 0.4 : 1,
                    transition: "all 0.3s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                      background: isDone ? T.greenDim : isFailed ? T.redDim : isActive ? T.greenDim : "transparent",
                      border: `1px solid ${isDone ? T.green : isFailed ? T.red : isActive ? T.green + "60" : T.border}`,
                      transition: "all 0.3s",
                    }}>
                      {isDone ? "✓" : isFailed ? "✗" : step.icon}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: isDone ? T.green : isFailed ? T.red : isActive ? T.text : T.textDim }}>
                        {step.label}
                      </div>
                      <div style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono }}>
                        {step.desc}
                      </div>
                    </div>
                    {isActive && (
                      <div style={{ width: 12, height: 12, borderRadius: "50%", border: `2px solid ${T.green}`, borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                    )}
                  </div>

                  {/* Logs */}
                  {logs.length > 0 && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                      {logs.map((log, li) => (
                        <div key={li} style={{ fontSize: 11, fontFamily: T.mono, color: log.msg.startsWith("✓") ? T.green : T.textMuted, marginTop: li > 0 ? 4 : 0 }}>
                          {log.msg}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {error && (
            <Card style={{ marginTop: 16, borderColor: T.red + "40" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.red, fontFamily: T.mono, marginBottom: 8 }}>ERROR AT STEP {currentStep + 1}: {STEPS[currentStep]?.label?.toUpperCase()}</div>
              <div style={{ fontSize: 12, color: T.textMuted, fontFamily: T.mono, wordBreak: "break-all" }}>{error}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  onClick={() => setView("intake")}
                  style={{ padding: "8px 16px", borderRadius: T.radius, border: `1px solid ${T.border}`, background: "transparent", color: T.text, fontSize: 12, fontFamily: T.mono, cursor: "pointer" }}
                >
                  ← Back to Intake
                </button>
                {/* BUG FIX: Allow viewing partial results when pipeline errors mid-run */}
                {hasPartialResults && (
                  <button
                    onClick={() => setView("results")}
                    style={{ padding: "8px 16px", borderRadius: T.radius, border: `1px solid ${T.amber}40`, background: T.amberDim, color: T.amber, fontSize: 12, fontFamily: T.mono, cursor: "pointer" }}
                  >
                    View Partial Results ({Object.keys(stepResults).length}/{STEPS.length} steps)
                  </button>
                )}
                <button
                  onClick={runPipeline}
                  style={{ padding: "8px 16px", borderRadius: T.radius, border: `1px solid ${T.green}40`, background: T.greenDim, color: T.green, fontSize: 12, fontFamily: T.mono, cursor: "pointer" }}
                >
                  Retry ↻
                </button>
              </div>
            </Card>
          )}
        </div>

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── RESULTS VIEW ────────────────────────────────────────────────────────
  const { intel, comps, condition, rehab, financials } = stepResults;
  const score = financials?.dealScore || 0;
  const verdict = financials?.verdict || "—";
  const verdictColor = verdict === "BUY" ? "green" : verdict === "NEGOTIATE" ? "amber" : "red";

  // BUG FIX: Find base case scenario by name instead of hardcoded index
  const baseCase = findScenario(financials?.profitScenarios, "base", 1);

  const TABS = [
    { id: "summary", label: "Summary" },
    { id: "comps", label: "Comps" },
    { id: "condition", label: "Condition" },
    { id: "risk", label: "Risk" },
    { id: "rehab", label: "Rehab" },
    { id: "profit", label: "Profit" },
  ];

  // Determine which tabs have data (for partial results)
  const tabHasData = {
    summary: !!financials,
    comps: !!comps,
    condition: !!condition,
    risk: !!condition?.floodRisk,
    rehab: !!rehab,
    profit: !!financials?.profitScenarios,
  };

  const renderSummary = () => {
    if (!financials) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Deal scoring did not complete. Switch to a completed tab to see partial data.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Score + Verdict */}
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <ScoreRing score={score} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <Badge color={verdictColor}>{verdict}</Badge>
              <div style={{ fontSize: 14, color: T.text, marginTop: 10, lineHeight: 1.6 }}>
                {financials?.verdictReason || "—"}
              </div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 12, lineHeight: 1.6, fontStyle: "italic", borderLeft: `2px solid ${T.green}40`, paddingLeft: 12 }}>
                {financials?.closerTake || "—"}
              </div>
            </div>
          </div>
        </Card>

        {/* Key Metrics Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          {[
            { label: "ASKING", value: fmt(Number(sanitizePrice(form.askingPrice))), color: T.text },
            { label: "ARV (EXPECTED)", value: fmt(comps?.arvAnalysis?.arvExpected), color: T.blue },
            { label: "COMP CONFIDENCE", value: `${comps?.arvAnalysis?.compConfidence || "?"}/10`, color: (comps?.arvAnalysis?.compConfidence || 0) >= 7 ? T.green : T.amber },
            { label: "CONDITION", value: condition?.conditionAssessment?.overallGrade || "?", color: T.text },
            { label: "FLOOD RISK", value: condition?.floodRisk?.overallRisk || "?", color: condition?.floodRisk?.overallRisk === "LOW" ? T.green : condition?.floodRisk?.overallRisk === "MODERATE" ? T.amber : T.red },
            { label: "BASE ROI", value: pct(baseCase?.roi), color: (baseCase?.roi || 0) > 20 ? T.green : T.amber },
          ].map((m) => (
            <Card key={m.label} style={{ padding: 14, textAlign: "center" }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono, letterSpacing: "0.5px", marginBottom: 6 }}>{m.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: m.color, fontFamily: T.mono }}>{m.value}</div>
            </Card>
          ))}
        </div>

        {/* Negotiation */}
        {financials?.negotiation && (
          <Card>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.green, fontFamily: T.mono, letterSpacing: "0.5px", marginBottom: 12 }}>NEGOTIATION STRATEGY</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {[
                { label: "Opening Offer", value: fmt(financials.negotiation.openingOffer) },
                { label: "Max Offer", value: fmt(financials.negotiation.maxOffer) },
                { label: "Walk Away", value: fmt(financials.negotiation.walkaway) },
              ].map((n) => (
                <div key={n.label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono, marginBottom: 4 }}>{n.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: T.mono, color: T.text }}>{n.value}</div>
                </div>
              ))}
            </div>
            {financials.negotiation.tactics && (
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 12, lineHeight: 1.6, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                {financials.negotiation.tactics}
              </div>
            )}
          </Card>
        )}

        {/* Strengths & Risks */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.green, fontFamily: T.mono, marginBottom: 10 }}>STRENGTHS</div>
            {(financials?.strengths || []).map((s, i) => (
              <div key={i} style={{ fontSize: 12, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                <span style={{ color: T.green, marginRight: 6 }}>+</span>{s}
              </div>
            ))}
          </Card>
          <Card>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.red, fontFamily: T.mono, marginBottom: 10 }}>RISK FACTORS</div>
            {(financials?.riskFactors || []).map((r, i) => (
              <div key={i} style={{ fontSize: 12, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                <span style={{ color: T.red, marginRight: 6 }}>!</span>{r}
              </div>
            ))}
          </Card>
        </div>
      </div>
    );
  };

  const renderComps = () => {
    if (!comps) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Comp analysis did not complete.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ARV Summary */}
        <Card>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.blue, fontFamily: T.mono, marginBottom: 12 }}>ARV RANGE</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            {[
              { label: "LOW", value: fmt(comps?.arvAnalysis?.arvLow) },
              { label: "EXPECTED", value: fmt(comps?.arvAnalysis?.arvExpected) },
              { label: "HIGH", value: fmt(comps?.arvAnalysis?.arvHigh) },
              { label: "$/SQFT", value: comps?.arvAnalysis?.medianPricePerSqft ? `$${Math.round(comps.arvAnalysis.medianPricePerSqft)}` : "—" },
            ].map((m) => (
              <div key={m.label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: T.mono, color: T.text }}>{m.value}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Comp Table */}
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.blue, fontFamily: T.mono }}>COMPARABLE SALES ({(comps?.comps || []).length})</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: T.mono }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Address", "Price", "$/sf", "Bed/Ba", "Sqft", "Condition", "Dist", "Score"].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: T.textMuted, fontWeight: 600, fontSize: 10, letterSpacing: "0.5px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(comps?.comps || []).map((c, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px", color: T.text, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address}</td>
                    <td style={{ padding: "10px 12px", color: T.green }}>{fmt(c.salePrice)}</td>
                    <td style={{ padding: "10px 12px", color: T.textMuted }}>${Math.round(c.pricePerSqft || 0)}</td>
                    <td style={{ padding: "10px 12px", color: T.textMuted }}>{c.beds}/{c.baths}</td>
                    <td style={{ padding: "10px 12px", color: T.textMuted }}>{c.sqft?.toLocaleString()}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <Badge color={c.condition === "renovated" ? "green" : c.condition === "updated" ? "blue" : c.condition === "distressed" ? "red" : "amber"}>
                        {c.condition}
                      </Badge>
                    </td>
                    <td style={{ padding: "10px 12px", color: T.textMuted }}>{c.distanceMiles}mi</td>
                    <td style={{ padding: "10px 12px", color: (c.relevanceScore || 0) >= 7 ? T.green : T.amber }}>{c.relevanceScore}/10</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Market Context */}
        {comps?.marketContext && (
          <Card>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.blue, fontFamily: T.mono, marginBottom: 10 }}>MARKET CONTEXT</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
              {[
                { label: "INVENTORY", value: comps.marketContext.inventoryLevel },
                { label: "AVG DOM", value: comps.marketContext.avgDaysOnMarket ? `${comps.marketContext.avgDaysOnMarket}d` : "—" },
                { label: "PRICE TREND", value: comps.marketContext.priceDirection },
                { label: "BUYER DEMAND", value: comps.marketContext.buyerDemand },
              ].map((m) => (
                <div key={m.label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono, marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: T.mono, color: T.text, textTransform: "capitalize" }}>{m.value}</div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  };

  const renderCondition = () => {
    if (!condition) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Condition assessment did not complete.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 42, fontWeight: 700, fontFamily: T.mono, color: T.text }}>
              {condition?.conditionAssessment?.overallGrade || "?"}
            </div>
            <div>
              <Badge color={
                condition?.conditionAssessment?.overallGrade === "A" || condition?.conditionAssessment?.overallGrade === "B" ? "green" :
                condition?.conditionAssessment?.overallGrade === "C" ? "amber" : "red"
              }>
                {condition?.conditionAssessment?.classification || "Unknown"}
              </Badge>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(condition?.conditionAssessment?.systems || []).map((sys, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: T.bg, borderRadius: T.radius }}>
                <StatusDot status={sys.status} />
                <div style={{ width: 90, fontSize: 12, fontWeight: 600, fontFamily: T.mono, color: T.text }}>{sys.name}</div>
                <Badge color={sys.status === "Good" ? "green" : sys.status === "Fair" ? "amber" : "red"}>{sys.status}</Badge>
                <div style={{ flex: 1, fontSize: 11, color: T.textMuted, marginLeft: 8 }}>{sys.notes}</div>
                {sys.houstonFlag && (
                  <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono }}>⚠ {sys.houstonFlag}</div>
                )}
              </div>
            ))}
          </div>
        </Card>
        {(condition?.dealKillers || []).length > 0 && (
          <Card style={{ borderColor: T.red + "40" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.red, fontFamily: T.mono, marginBottom: 10 }}>⚠ DEAL KILLERS</div>
            {condition.dealKillers.map((dk, i) => (
              <div key={i} style={{ fontSize: 12, color: T.text, marginTop: 6, lineHeight: 1.5 }}>• {dk}</div>
            ))}
          </Card>
        )}
      </div>
    );
  };

  const renderRisk = () => {
    if (!condition?.floodRisk) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Risk assessment did not complete.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: T.mono, color: T.text }}>FLOOD RISK:</div>
            <Badge color={condition?.floodRisk?.overallRisk === "LOW" ? "green" : condition?.floodRisk?.overallRisk === "MODERATE" ? "amber" : "red"}>
              {condition?.floodRisk?.overallRisk || "UNKNOWN"}
            </Badge>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
            {[
              { label: "FEMA ZONE", value: condition?.floodRisk?.femaZone || "—" },
              { label: "HARVEY IMPACT", value: condition?.floodRisk?.harveyImpact || "—" },
              { label: "FLOOD INS. EST.", value: condition?.floodRisk?.insuranceEstimate ? fmt(condition.floodRisk.insuranceEstimate) + "/yr" : "—" },
            ].map((m) => (
              <div key={m.label} style={{ textAlign: "center", padding: 12, background: T.bg, borderRadius: T.radius }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 14, fontWeight: 600, fontFamily: T.mono, color: T.text, textTransform: "capitalize" }}>{m.value}</div>
              </div>
            ))}
          </div>
          {(condition?.floodRisk?.factors || []).map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: T.bg, borderRadius: T.radius, marginTop: 8 }}>
              <Badge color={f.risk === "LOW" ? "green" : f.risk === "MODERATE" ? "amber" : "red"}>{f.risk}</Badge>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{f.factor}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{f.details}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    );
  };

  const renderRehab = () => {
    if (!rehab) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Rehab estimation did not complete.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {["conservative", "expected", "aggressive"].map((tier) => {
          const s = rehab?.scenarios?.[tier];
          if (!s) return null;
          const tierColor = tier === "conservative" ? T.green : tier === "expected" ? T.amber : T.red;
          return (
            <Card key={tier}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <Badge color={tier === "conservative" ? "green" : tier === "expected" ? "amber" : "red"}>
                    {s.label || tier}
                  </Badge>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>{s.scope}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color: tierColor }}>{fmt(s.totalExpected)}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.mono }}>{s.timelineWeeks} weeks</div>
                </div>
              </div>
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
                {(s.lineItems || []).map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < s.lineItems.length - 1 ? `1px solid ${T.border}` : "none" }}>
                    <div style={{ fontSize: 12, color: T.text }}>{item.item}</div>
                    <div style={{ fontSize: 12, fontFamily: T.mono, color: T.textMuted }}>{fmt(item.expected)}</div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
        {(rehab?.criticalItems || []).length > 0 && (
          <Card style={{ borderColor: T.amber + "40" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.amber, fontFamily: T.mono, marginBottom: 8 }}>CRITICAL — MUST ADDRESS</div>
            {rehab.criticalItems.map((c, i) => (
              <div key={i} style={{ fontSize: 12, color: T.text, marginTop: 6 }}>• {c}</div>
            ))}
          </Card>
        )}
      </div>
    );
  };

  const renderProfit = () => {
    if (!financials?.profitScenarios) {
      return (
        <Card>
          <div style={{ textAlign: "center", color: T.textMuted, fontFamily: T.mono, fontSize: 13, padding: 20 }}>
            Profit modeling did not complete.
          </div>
        </Card>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {(financials?.profitScenarios || []).map((s, i) => {
          const profitable = (s.netProfit || 0) > 0;
          return (
            <Card key={i} style={{ borderColor: profitable ? T.green + "20" : T.red + "20" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <Badge color={i === 0 ? "green" : i === 1 ? "amber" : "red"}>{s.name}</Badge>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color: profitable ? T.green : T.red }}>
                  {fmt(s.netProfit)}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, fontSize: 11, fontFamily: T.mono }}>
                {[
                  { label: "ARV", value: fmt(s.arvUsed) },
                  { label: "ALL-IN", value: fmt(s.totalInvested) },
                  { label: "ROI", value: pct(s.roi) },
                  { label: "MARGIN", value: pct(s.margin) },
                ].map((m) => (
                  <div key={m.label} style={{ textAlign: "center", padding: 8, background: T.bg, borderRadius: T.radius }}>
                    <div style={{ color: T.textMuted, fontSize: 9, marginBottom: 3 }}>{m.label}</div>
                    <div style={{ color: T.text, fontWeight: 600 }}>{m.value}</div>
                  </div>
                ))}
              </div>
              {/* Cost breakdown */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
                {[
                  { label: "Acquisition", value: fmt(s.acquisitionCost) },
                  { label: "Rehab", value: fmt(s.rehabCost) },
                  { label: "Holding (5mo)", value: fmt(s.holdingCosts) },
                  { label: "Buy Closing", value: fmt(s.buyClosing) },
                  { label: "Sell Closing", value: fmt(s.sellClosing) },
                  { label: "Gross Profit", value: fmt(s.grossProfit) },
                ].map((m) => (
                  <div key={m.label} style={{ display: "flex", justifyContent: "space-between", color: T.textMuted, fontFamily: T.mono }}>
                    <span>{m.label}</span>
                    <span style={{ color: T.text }}>{m.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    );
  };

  const tabContent = {
    summary: renderSummary,
    comps: renderComps,
    condition: renderCondition,
    risk: renderRisk,
    rehab: renderRehab,
    profit: renderProfit,
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: T.sans, padding: "24px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{form.address}</div>
            <div style={{ fontSize: 11, color: T.textMuted, fontFamily: T.mono, marginTop: 2 }}>
              Evaluated {new Date().toLocaleDateString()} · Asking {fmt(Number(sanitizePrice(form.askingPrice)))}
            </div>
          </div>
          <button
            onClick={() => { setView("intake"); setActiveTab("summary"); }}
            style={{
              padding: "8px 16px",
              borderRadius: T.radius,
              border: `1px solid ${T.border}`,
              background: "transparent",
              color: T.text,
              fontSize: 12,
              fontFamily: T.mono,
              cursor: "pointer",
            }}
          >
            New Evaluation
          </button>
        </div>

        {/* Partial results warning banner */}
        {error && (
          <Card style={{ marginBottom: 16, borderColor: T.amber + "40", padding: "12px 16px" }}>
            <div style={{ fontSize: 11, fontFamily: T.mono, color: T.amber }}>
              ⚠ PARTIAL RESULTS — Pipeline errored at Step {currentStep + 1} ({STEPS[currentStep]?.label}). Data below is from completed steps only.
            </div>
          </Card>
        )}

        {/* Tabs */}
        <div style={{
          display: "flex",
          gap: 2,
          marginBottom: 20,
          background: T.surface,
          borderRadius: T.radius,
          padding: 3,
          border: `1px solid ${T.border}`,
        }}>
          {TABS.map((tab) => {
            const hasData = tabHasData[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: 1,
                  padding: "10px 8px",
                  borderRadius: 6,
                  border: "none",
                  background: activeTab === tab.id ? T.surfaceHover : "transparent",
                  color: activeTab === tab.id ? T.text : hasData ? T.textMuted : T.textDim,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: T.mono,
                  cursor: "pointer",
                  transition: "all 0.2s",
                  letterSpacing: "0.3px",
                  opacity: hasData ? 1 : 0.4,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {tabContent[activeTab]?.()}
      </div>
    </div>
  );
}
