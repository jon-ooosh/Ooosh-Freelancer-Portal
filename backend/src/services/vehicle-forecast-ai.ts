/**
 * Vehicle forecast — AI health assessment.
 *
 * Takes the deterministic forecast (vehicle-forecast.ts) plus recent
 * unstructured prep/service notes and asks Claude for a plain-English health
 * narrative + a prioritised "watch / do" list. Cached in
 * vehicle_forecast_assessments; regenerated weekly by the scheduler and
 * on-demand via the Forecast tab "Regenerate" button.
 *
 * The deterministic numbers stay authoritative — the AI's job is synthesis
 * (spotting the across-signals story: "tyres fine but oil top-ups rising AND a
 * recurring light fault → worth a garage look before the next long tour") and
 * reading the free-text notes the structured cards can't. Model: Sonnet, with a
 * cached system prompt. Cost is pennies per van per run.
 */

import { getAnthropicClient, isAnthropicConfigured } from '../config/anthropic';
import { query } from '../config/database';
import { buildVehicleForecast, type VehicleForecast } from './vehicle-forecast';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 1200;

const SYSTEM_PROMPT = `You are a fleet maintenance analyst for Ooosh Tours, a UK music-tour vehicle hire company. You are given a single van's forward-looking health data — tyre wear projections, mileage pace, service-due, MOT/Tax/TFL compliance runway, ULEZ status, fluid top-up frequency, 12-month running costs, recurring issues, and recent free-text prep/service notes.

Write a concise, practical assessment for the warehouse/ops team. Be specific and grounded ONLY in the data given — never invent figures. Prefer the across-signals story (e.g. "tyres are fine but oil top-ups are climbing and there's a recurring nearside light fault") over restating each number.

Rules:
- Tyre thresholds: plan replacement at 5mm, replace at 4mm. Never reference the 1.6mm legal limit as a target — Ooosh acts well before legal.
- Fronts and rears wear at different rates; call out the worst corner/axle.
- If a fluid is topped up frequently (a "watch" status), flag possible consumption worth a mechanic's eye.
- Compliance: only items listed under COMPLIANCE are tracked, each with a real date. Anything overdue is urgent; anything within ~30 days is worth booking. Do NOT flag missing compliance items — insurance is a blanket fleet policy (not tracked per-van), and an absent TFL line just means that van isn't registered (e.g. a 6-seater that can't claim the discount). Never recommend "set/confirm the insurance date" or "confirm TFL status".
- ULEZ: a van shown as "ULEZ compliant: yes" needs no action. Only mention ULEZ if it is explicitly non-compliant.
- Keep watch_items and recommendations SHORT and actionable. Empty arrays are fine for a healthy van.
- overall_status: "good" (nothing pressing), "watch" (a few things to keep an eye on), "attention" (something needs booking/doing soon).
- Return ONLY valid JSON matching the schema. No markdown, no commentary.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    overall_status: { type: 'string', enum: ['good', 'watch', 'attention'] },
    watch_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['label', 'detail', 'severity'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          reason: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['action', 'reason', 'priority'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'summary', 'overall_status', 'watch_items', 'recommendations'],
  additionalProperties: false,
};

export interface VehicleAssessment {
  id: string;
  vehicle_id: string;
  headline: string | null;
  summary: string | null;
  watch_items: Array<{ label: string; detail: string; severity: string }>;
  recommendations: Array<{ action: string; reason: string; priority: string }>;
  overall_status: string | null;
  model: string | null;
  trigger: string;
  generated_at: string;
}

/** Compact the forecast into the text payload Claude reasons over. */
function forecastToPrompt(f: VehicleForecast): string {
  const lines: string[] = [];
  lines.push(`Vehicle: ${f.vehicle.reg} (${f.vehicle.simpleType || 'unknown type'})`);
  lines.push(`Current mileage: ${f.vehicle.currentMileage ?? 'unknown'}`);
  if (f.mileage.perWeek != null) lines.push(`Mileage pace: ~${f.mileage.perWeek} mi/week (~${f.mileage.annualProjected} mi/year projected), from ${f.mileage.readings} readings`);

  lines.push('\nTYRES (per corner — current tread mm, wear mm/1000mi, projection):');
  for (const c of f.tyres.corners) {
    if (c.currentTread == null) { lines.push(`  ${c.corner} (${c.label}): no readings`); continue; }
    const proj: string[] = [];
    if (c.milesTo5mm != null) proj.push(`~${c.milesTo5mm}mi to 5mm`);
    if (c.milesTo4mm != null) proj.push(`~${c.milesTo4mm}mi to 4mm`);
    lines.push(`  ${c.corner} (${c.label}): ${c.currentTread}mm [${c.status}]${c.wearRatePer1000 != null ? `, wearing ${c.wearRatePer1000}mm/1000mi` : ', wear rate unknown'}${proj.length ? ', ' + proj.join(', ') : ''}${c.resetCount > 0 ? `, ${c.resetCount} tyre change(s) detected` : ''}`);
  }

  lines.push('\nSERVICE:');
  if (f.service.nextDueMileage != null) {
    lines.push(`  Next service due at ${f.service.nextDueMileage} mi (${f.service.milesUntil != null ? `${f.service.milesUntil} mi away` : 'distance unknown'}${f.service.etaWeeks != null ? `, ~${f.service.etaWeeks} weeks at current pace` : ''}) [${f.service.status}]`);
  } else lines.push('  Next service mileage not set');
  if (f.service.lastServiceDate) lines.push(`  Last service: ${f.service.lastServiceDate}${f.service.lastServiceMileage != null ? ` at ${f.service.lastServiceMileage} mi` : ''}`);

  lines.push('\nCOMPLIANCE (only tracked items with a real date are listed):');
  if (f.compliance.length) {
    for (const c of f.compliance) {
      lines.push(`  ${c.kind}: ${c.due}${c.days != null ? ` (${c.days} days)` : ''} [${c.status}]`);
    }
  } else {
    lines.push('  No tracked compliance dates on file.');
  }
  if (f.vehicle.ulezCompliant != null) {
    lines.push(`  ULEZ compliant: ${f.vehicle.ulezCompliant ? 'yes' : 'NO — not compliant'}`);
  }

  lines.push('\nFLUIDS (top-up frequency):');
  for (const fl of f.fluids) {
    if (fl.preps === 0) continue;
    lines.push(`  ${fl.label}: topped up ${fl.topUps} of ${fl.preps} preps${fl.milesBetween != null ? ` (~every ${fl.milesBetween} mi)` : ''} [${fl.status}]`);
  }

  lines.push('\nCOSTS (last 12 months):');
  lines.push(`  Total £${f.costs.last12mTotal} (service £${f.costs.serviceTotal} + fuel £${f.costs.fuelTotal})${f.costs.perMile != null ? `, ~£${f.costs.perMile}/mile` : ''}`);

  if (f.recurringIssues.length) {
    lines.push('\nRECURRING ISSUES:');
    for (const ri of f.recurringIssues) lines.push(`  ${ri.label}: ${ri.count}x (last ${ri.lastDate || '?'})`);
  }

  if (f.notesForAi.length) {
    lines.push('\nRECENT NOTES (prep + service free text):');
    for (const n of f.notesForAi.slice(0, 20)) lines.push(`  - ${n}`);
  }

  return lines.join('\n');
}

/** Generate + store an assessment. Returns null if there's no forecast or AI is off. */
export async function generateVehicleAssessment(
  vehicleId: string,
  opts: { trigger: 'scheduled' | 'manual'; userId?: string | null },
): Promise<VehicleAssessment | null> {
  if (!isAnthropicConfigured()) throw new Error('ANTHROPIC_API_KEY not configured');
  const forecast = await buildVehicleForecast(vehicleId);
  if (!forecast) return null;

  const client = getAnthropicClient();
  const resp = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: forecastToPrompt(forecast) }] }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output_config: { format: { type: 'json_schema', schema: SCHEMA as any } } as any,
  });

  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('Claude returned no text content');
  let parsed: {
    headline: string; summary: string; overall_status: string;
    watch_items: Array<{ label: string; detail: string; severity: string }>;
    recommendations: Array<{ action: string; reason: string; priority: string }>;
  };
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    const m = textBlock.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Claude returned unparseable response');
    parsed = JSON.parse(m[0]);
  }

  const ins = await query(
    `INSERT INTO vehicle_forecast_assessments
       (vehicle_id, headline, summary, watch_items, recommendations, overall_status, model, trigger, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, vehicle_id, headline, summary, watch_items, recommendations, overall_status, model, trigger, generated_at`,
    [
      vehicleId,
      parsed.headline || null,
      parsed.summary || null,
      JSON.stringify(parsed.watch_items || []),
      JSON.stringify(parsed.recommendations || []),
      parsed.overall_status || null,
      MODEL_ID,
      opts.trigger,
      opts.userId || null,
    ],
  );
  return ins.rows[0] as VehicleAssessment;
}

/** Latest cached assessment for a vehicle, or null. */
export async function getLatestAssessment(vehicleId: string): Promise<VehicleAssessment | null> {
  try {
    const res = await query(
      `SELECT id, vehicle_id, headline, summary, watch_items, recommendations, overall_status, model, trigger, generated_at
         FROM vehicle_forecast_assessments
        WHERE vehicle_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [vehicleId],
    );
    return res.rows[0] ? (res.rows[0] as VehicleAssessment) : null;
  } catch (err) {
    // Degrade gracefully if the table doesn't exist yet (migration 142 not run) —
    // the deterministic forecast still loads; the assessment panel just shows empty.
    if ((err as { code?: string })?.code === '42P01') {
      console.warn('[vehicle-forecast] vehicle_forecast_assessments missing — run migration 142');
      return null;
    }
    throw err;
  }
}

/** Active fleet vehicle ids for the scheduled batch. */
export async function getActiveFleetVehicleIds(): Promise<string[]> {
  const res = await query(
    `SELECT id FROM fleet_vehicles
      WHERE is_active = true AND COALESCE(fleet_group,'') <> 'old_sold'
      ORDER BY reg`,
  );
  return res.rows.map((r) => r.id as string);
}

/**
 * Scheduled batch — regenerate every active van's assessment. Sequential with a
 * small delay so we never spike the Anthropic / DB rate. A failure on one van is
 * logged and skipped, never aborts the run. Returns counts for the scheduler log.
 */
export async function runScheduledForecastAssessments(): Promise<{ done: number; failed: number; skipped: number }> {
  if (!isAnthropicConfigured()) {
    console.warn('[vehicle-forecast] scheduled run skipped — ANTHROPIC_API_KEY not configured');
    return { done: 0, failed: 0, skipped: 0 };
  }
  const ids = await getActiveFleetVehicleIds();
  let done = 0, failed = 0, skipped = 0;
  for (const id of ids) {
    try {
      const a = await generateVehicleAssessment(id, { trigger: 'scheduled' });
      if (a) done++; else skipped++;
    } catch (err) {
      failed++;
      console.error(`[vehicle-forecast] assessment failed for ${id}:`, err);
    }
    await new Promise((r) => setTimeout(r, 1500)); // gentle pacing
  }
  return { done, failed, skipped };
}
