/**
 * locationScoring.js
 * Deterministic filter-then-score engine for FastLocations.ai
 *
 * Contract: ProjectCriteria JSON in, ranked candidates out.
 * Same inputs always produce the same ranking (stable tie-break on candidate id).
 *
 * Usage:
 *   const { scoreLocations } = require('./locationScoring');
 *   const results = scoreLocations(projectCriteria, candidates);
 */

'use strict';

// ---------------------------------------------------------------------------
// Industry default weight presets (used when ProjectCriteria omits weights)
// ---------------------------------------------------------------------------
const INDUSTRY_PRESETS = {
  manufacturing: [
    { field: 'laborForce',     type: 'benefit',  weight: 0.25 },
    { field: 'incentiveValue', type: 'benefit',  weight: 0.20 },
    { field: 'powerCostKwh',   type: 'cost',     weight: 0.15 },
    { field: 'distHighwayKm',  type: 'distance', weight: 0.15, halfValue: 10 },
    { field: 'siteReadiness',  type: 'benefit',  weight: 0.15 },
    { field: 'taxBurden',      type: 'cost',     weight: 0.10 },
  ],
  logistics: [
    { field: 'distHighwayKm',  type: 'distance', weight: 0.30, halfValue: 5 },
    { field: 'laborForce',     type: 'benefit',  weight: 0.25 },
    { field: 'distIntermodalKm', type: 'distance', weight: 0.15, halfValue: 25 },
    { field: 'incentiveValue', type: 'benefit',  weight: 0.10 },
    { field: 'landCostAcre',   type: 'cost',     weight: 0.10 },
    { field: 'taxBurden',      type: 'cost',     weight: 0.10 },
  ],
  datacenter: [
    { field: 'powerCostKwh',    type: 'cost',    weight: 0.30 },
    { field: 'powerCapacityMw', type: 'benefit', weight: 0.25 },
    { field: 'fiberProviders',  type: 'benefit', weight: 0.15 },
    { field: 'incentiveValue',  type: 'benefit', weight: 0.15 },
    { field: 'waterCapacity',   type: 'benefit', weight: 0.10 },
    { field: 'taxBurden',       type: 'cost',    weight: 0.05 },
  ],
};

// ---------------------------------------------------------------------------
// Hard-constraint operators
// ---------------------------------------------------------------------------
const OPS = {
  '>=':  (a, b) => a >= b,
  '<=':  (a, b) => a <= b,
  '>':   (a, b) => a > b,
  '<':   (a, b) => a < b,
  '==':  (a, b) => a === b,
  '!=':  (a, b) => a !== b,
  'in':  (a, b) => Array.isArray(b) && b.includes(a),
  'notin': (a, b) => Array.isArray(b) && !b.includes(a),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateProjectCriteria(pc) {
  const errors = [];

  let criteria = pc.criteria;
  if (!criteria || criteria.length === 0) {
    if (pc.industry && INDUSTRY_PRESETS[pc.industry]) {
      criteria = INDUSTRY_PRESETS[pc.industry];
    } else {
      errors.push('No criteria supplied and no industry preset matches.');
      return { errors, criteria: [] };
    }
  }

  const weightSum = criteria.reduce((s, c) => s + (c.weight || 0), 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    // Auto-renormalize rather than fail — intake form sliders rarely sum exactly to 1
    criteria = criteria.map(c => ({ ...c, weight: c.weight / weightSum }));
  }

  for (const c of criteria) {
    if (!c.field) errors.push(`Criterion missing "field": ${JSON.stringify(c)}`);
    if (!['benefit', 'cost', 'distance'].includes(c.type)) {
      errors.push(`Criterion "${c.field}" has invalid type "${c.type}" (benefit|cost|distance).`);
    }
    if (c.type === 'distance' && !(c.halfValue > 0)) {
      errors.push(`Distance criterion "${c.field}" requires positive "halfValue".`);
    }
  }

  for (const hc of pc.hardConstraints || []) {
    if (!OPS[hc.op]) errors.push(`Unknown hard-constraint operator "${hc.op}" on "${hc.field}".`);
  }

  return { errors, criteria };
}

// ---------------------------------------------------------------------------
// Stage 1 — Hard constraints (binary filter)
// ---------------------------------------------------------------------------
function applyHardConstraints(hardConstraints, candidates) {
  const passed = [];
  const rejected = [];

  for (const cand of candidates) {
    const failures = [];
    for (const hc of hardConstraints || []) {
      const val = cand.attributes[hc.field];
      if (val === undefined || val === null || !OPS[hc.op](val, hc.value)) {
        failures.push(`${hc.field} ${hc.op} ${JSON.stringify(hc.value)} (actual: ${val ?? 'missing'})`);
      }
    }
    if (failures.length === 0) passed.push(cand);
    else rejected.push({ id: cand.id, name: cand.name, failedConstraints: failures });
  }

  return { passed, rejected };
}

// ---------------------------------------------------------------------------
// Stage 2 — Normalization
// ---------------------------------------------------------------------------
function minMaxNormalize(values, invert) {
  const nums = values.filter(v => typeof v === 'number' && isFinite(v));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min;

  return values.map(v => {
    if (typeof v !== 'number' || !isFinite(v)) return null;      // missing → handled later
    if (range === 0) return 1;                                    // all identical → full credit
    const n = (v - min) / range;
    return invert ? 1 - n : n;
  });
}

function percentileNormalize(values, invert) {
  const nums = values
    .map((v, i) => ({ v, i }))
    .filter(x => typeof x.v === 'number' && isFinite(x.v));

  // Average-rank percentile: robust to skewed distributions and outliers
  const sorted = [...nums].sort((a, b) => a.v - b.v);
  const ranks = new Map();
  let idx = 0;
  while (idx < sorted.length) {
    let j = idx;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[idx].v) j++;
    const avgRank = (idx + j) / 2;
    for (let k = idx; k <= j; k++) ranks.set(sorted[k].i, avgRank);
    idx = j + 1;
  }

  const denom = Math.max(sorted.length - 1, 1);
  return values.map((v, i) => {
    if (!ranks.has(i)) return null;
    const n = ranks.get(i) / denom;
    return invert ? 1 - n : n;
  });
}

function distanceNormalize(values, halfValue) {
  // n = 1 / (1 + d/d0): d=0 → 1.0, d=halfValue → 0.5, decays smoothly
  return values.map(v => {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
    return 1 / (1 + v / halfValue);
  });
}

// ---------------------------------------------------------------------------
// Stage 2 — Scoring
// ---------------------------------------------------------------------------
/**
 * @param {object} projectCriteria - ProjectCriteria JSON
 *   {
 *     projectId: string,
 *     industry: 'manufacturing'|'logistics'|'datacenter'|string,
 *     normalization: 'minmax'|'percentile',        // default 'minmax'
 *     missingValuePolicy: 'zero'|'exclude',        // default 'zero'
 *     hardConstraints: [{ field, op, value }],
 *     criteria: [{ field, type, weight, halfValue? }]
 *   }
 * @param {Array} candidates - [{ id, name, attributes: { field: number|string, ... } }]
 * @returns {object} { ranked, rejected, meta }
 */
function scoreLocations(projectCriteria, candidates) {
  const { errors, criteria } = validateProjectCriteria(projectCriteria);
  if (errors.length) throw new Error('Invalid ProjectCriteria:\n' + errors.join('\n'));
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ranked: [], rejected: [], meta: { criteria, errors: ['No candidates supplied.'] } };
  }

  const normalization = projectCriteria.normalization || 'minmax';
  const missingPolicy = projectCriteria.missingValuePolicy || 'zero';

  // Stage 1
  const { passed, rejected } = applyHardConstraints(projectCriteria.hardConstraints, candidates);
  if (passed.length === 0) {
    return { ranked: [], rejected, meta: { criteria, note: 'All candidates failed hard constraints.' } };
  }

  // Stage 2 — normalize each criterion ACROSS the surviving candidate set
  const normalized = {}; // field -> array of normalized values aligned to `passed`
  for (const c of criteria) {
    const raw = passed.map(cand => cand.attributes[c.field]);
    if (c.type === 'distance') {
      normalized[c.field] = distanceNormalize(raw, c.halfValue);
    } else {
      const invert = c.type === 'cost';
      normalized[c.field] = normalization === 'percentile'
        ? percentileNormalize(raw, invert)
        : minMaxNormalize(raw, invert);
    }
  }

  // Weighted sum with per-criterion sub-scores for explainability
  const ranked = passed.map((cand, i) => {
    const subScores = {};
    let score = 0;
    let usedWeight = 0;

    for (const c of criteria) {
      const n = normalized[c.field][i];
      if (n === null) {
        if (missingPolicy === 'zero') {
          subScores[c.field] = { normalized: 0, weight: c.weight, contribution: 0, missing: true };
        } else {
          // 'exclude': drop the criterion for this candidate, renormalize below
          subScores[c.field] = { normalized: null, weight: c.weight, contribution: null, missing: true };
          continue;
        }
      } else {
        const contribution = c.weight * n;
        subScores[c.field] = {
          normalized: round4(n),
          weight: c.weight,
          contribution: round4(contribution),
        };
        score += contribution;
      }
      usedWeight += c.weight;
    }

    // Renormalize when criteria were excluded so candidates stay comparable
    if (missingPolicy === 'exclude' && usedWeight > 0 && usedWeight < 1) {
      score = score / usedWeight;
    }

    return {
      id: cand.id,
      name: cand.name,
      score: round4(score),
      subScores,
    };
  });

  // Deterministic sort: score desc, then id asc as stable tie-break
  ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  ranked.forEach((r, i) => { r.rank = i + 1; });

  return {
    ranked,
    rejected,
    meta: {
      projectId: projectCriteria.projectId,
      normalization,
      missingValuePolicy: missingPolicy,
      criteriaUsed: criteria,
      candidatesEvaluated: candidates.length,
      candidatesPassedConstraints: passed.length,
    },
  };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// ---------------------------------------------------------------------------
// Example (run: node locationScoring.js)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const projectCriteria = {
    projectId: 'PRJ-2026-041',
    industry: 'manufacturing',
    normalization: 'minmax',
    missingValuePolicy: 'zero',
    hardConstraints: [
      { field: 'acreage', op: '>=', value: 25 },
      { field: 'zoning', op: 'in', value: ['M1', 'M2'] },
    ],
    criteria: [
      { field: 'laborForce',     type: 'benefit',  weight: 0.25 },
      { field: 'incentiveValue', type: 'benefit',  weight: 0.20 },
      { field: 'powerCostKwh',   type: 'cost',     weight: 0.15 },
      { field: 'distHighwayKm',  type: 'distance', weight: 0.15, halfValue: 10 },
      { field: 'siteReadiness',  type: 'benefit',  weight: 0.15 },
      { field: 'taxBurden',      type: 'cost',     weight: 0.10 },
    ],
  };

  const candidates = [
    { id: 'S-101', name: 'Northgate Industrial Park', attributes: {
      acreage: 42, zoning: 'M2', laborForce: 185000, incentiveValue: 2400000,
      powerCostKwh: 0.071, distHighwayKm: 3.2, siteReadiness: 4, taxBurden: 0.021 } },
    { id: 'S-102', name: 'Riverbend Site B', attributes: {
      acreage: 60, zoning: 'M1', laborForce: 96000, incentiveValue: 3900000,
      powerCostKwh: 0.058, distHighwayKm: 11.5, siteReadiness: 3, taxBurden: 0.017 } },
    { id: 'S-103', name: 'Eastfield Commerce Center', attributes: {
      acreage: 18, zoning: 'M2', laborForce: 240000, incentiveValue: 1200000,
      powerCostKwh: 0.082, distHighwayKm: 1.1, siteReadiness: 5, taxBurden: 0.026 } },
    { id: 'S-104', name: 'Highway 7 Mega Site', attributes: {
      acreage: 130, zoning: 'M2', laborForce: 152000, incentiveValue: 5100000,
      powerCostKwh: 0.064, distHighwayKm: 0.8, siteReadiness: 2, taxBurden: 0.019 } },
  ];

  const result = scoreLocations(projectCriteria, candidates);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { scoreLocations, applyHardConstraints, validateProjectCriteria, INDUSTRY_PRESETS };
