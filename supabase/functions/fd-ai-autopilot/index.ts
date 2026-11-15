// Scheduled Asha autopilot for Financial Derivatives. Called only by pg_cron (pg_net) with a secret kept in the database
// (fd_ai_secret); shared code pinned to a public commit. Mirrors ma-ai-autopilot.
import { createClient } from "npm:@supabase/supabase-js@2";
import { LIMITS } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/config.ts";
import { hashUser, makeSampledLogger } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/log.ts";
import { routedProvider } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/provider.ts";
import { Admission, BreakerSet, ControlCache, TtlCache } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/resilience.ts";
import { SupabaseContent } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/content.ts";
import { runAutopilot } from "https://raw.githubusercontent.com/amarendra-sharma/International-Trade/6c8efde226c7aafdebaa77a0310218f47cfa4735/ai-instructor/server/it-ai-instructor/autopilot.ts";
import { FdSupabaseStore } from "../_shared/fd-store.ts";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const salt = Deno.env.get("AI_INSTRUCTOR_LOG_SALT") ?? "";
const store = new FdSupabaseStore(admin);
// deno-lint-ignore no-explicit-any
const deps: any = {
  subject: "financial derivatives", store, control: new ControlCache(() => store.getControl(), "normal"), breakers: new BreakerSet(),
  admissionWaitMs: LIMITS.admissionWaitMs, accessCache: new TtlCache(LIMITS.accessCacheTtlMs), assessCache: new TtlCache(LIMITS.assessmentCacheTtlMs),
  provider: routedProvider, extraHosts: [], content: new SupabaseContent(admin, "fd_ai_"),
  log: makeSampledLogger((l: string) => console.log(l), { infoSampleRate: LIMITS.logInfoSampleRate, perSecond: LIMITS.logPerSecondPerInstance, burst: 20 }),
  gate: new Admission(LIMITS.isolateMaxConcurrentTurns, LIMITS.admissionQueueMax),
  kek: Deno.env.get("AI_INSTRUCTOR_KEK") ?? "", platformKeyOwner: Deno.env.get("AI_INSTRUCTOR_PLATFORM_KEY_OWNER") || undefined, userHash: (id: string) => hashUser(id, salt),
};
Deno.serve(async (req: Request) => {
  const given = req.headers.get("x-autopilot-secret") ?? "";
  const { data: ok } = await admin.rpc("fd_ai_autopilot_check", { p: given });
  if (ok !== true) return new Response("forbidden", { status: 403 });
  const rep = await runAutopilot(deps).catch((e: Error) => ({ error: String(e?.message ?? e).slice(0, 120) }));
  return new Response(JSON.stringify(rep), { headers: { "content-type": "application/json" } });
});
