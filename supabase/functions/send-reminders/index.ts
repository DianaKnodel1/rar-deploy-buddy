// Deno Edge Function: send-reminders
//
// Sendet automatische Erinnerungsmails an drei Zielgruppen:
//   1. invite                — Bewerber akzeptiert, aber noch kein Account
//   2. confirm_email         — Account angelegt, E-Mail nicht bestätigt
//   3. complete_registration — Account bestätigt, Onboarding unvollständig
//
// Gates pro Empfänger + Typ:
//   - max. 5 Versuche
//   - min. 3 Tage seit letzter Reminder-Mail
//   - min. 3 Tage seit relevantem Event (Annahme / Account / Bestätigung)
//
// Trigger: pg_cron 1x täglich ODER manuell via POST { dry_run?: bool }
//
// Deploy:
//   supabase functions deploy send-reminders --no-verify-jwt

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import nodemailer from "https://esm.sh/nodemailer@6.9.14";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ATTEMPTS = 5;
const MIN_DAYS_BETWEEN = 3;
const NO_BOOKING_DAYS = 7;

// ─── Anti-Spam Throttling ───
// Max. echte Sends pro Typ und Ausführung (verhindert Burst-Send)
const MAX_SENDS_PER_RUN = 15;
// Wartezeit zwischen zwei echten Sends (Basis + zufällige Streuung)
const SEND_DELAY_MIN_MS = 2500;
const SEND_DELAY_MAX_MS = 5500;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitterDelay = () =>
  sleep(SEND_DELAY_MIN_MS + Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS)));

interface TenantRow {
  id: string;
  name: string;
  domain: string | null;
  logo_url: string | null;
  primary_color: string | null;
  sender_email: string | null;
  sender_name: string | null;
  reply_to_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  smtp_password: string | null;
}

type ReminderType = "invite" | "confirm_email" | "complete_registration" | "no_recent_booking";

interface SendCtx {
  admin: ReturnType<typeof createClient>;
  tenants: Map<string, TenantRow>;
  dryRun: boolean;
  results: { type: ReminderType; email: string; status: string; error?: string }[];
  sentCountByType: Map<ReminderType, number>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const dryRun = body?.dry_run === true;
    const onlyType: ReminderType | null = body?.only_type ?? null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Tenants vorladen
    const { data: tList, error: tErr } = await admin
      .from("tenants")
      .select("id,name,domain,logo_url,primary_color,sender_email,sender_name,reply_to_email,smtp_host,smtp_port,smtp_username,smtp_password");
    if (tErr) return json({ error: tErr.message }, 500);

    const tenants = new Map<string, TenantRow>();
    (tList ?? []).forEach((t: any) => tenants.set(t.id, t as TenantRow));

    const ctx: SendCtx = { admin, tenants, dryRun, results: [], sentCountByType: new Map() };

    if (!onlyType || onlyType === "invite") await runInvites(ctx);
    if (!onlyType || onlyType === "confirm_email") await runConfirmEmail(ctx);
    if (!onlyType || onlyType === "complete_registration") await runCompleteRegistration(ctx);
    if (!onlyType || onlyType === "no_recent_booking") await runNoRecentBooking(ctx);

    return json({
      success: true,
      dry_run: dryRun,
      sent: ctx.results.filter(r => r.status === "sent").length,
      skipped: ctx.results.filter(r => r.status === "skipped").length,
      failed: ctx.results.filter(r => r.status === "failed").length,
      details: ctx.results,
    }, 200);
  } catch (err: any) {
    console.error(err);
    return json({ error: err?.message ?? "Unknown error" }, 500);
  }
});

// ───── Gate ─────
async function canSend(
  admin: SendCtx["admin"],
  email: string,
  type: ReminderType,
): Promise<{ ok: boolean; nextAttempt: number; reason?: string }> {
  const { data, error } = await admin
    .from("reminder_log")
    .select("attempt, sent_at, status")
    .eq("email", email)
    .eq("reminder_type", type)
    .order("sent_at", { ascending: false });
  if (error) return { ok: false, nextAttempt: 0, reason: error.message };

  const sentLogs = (data ?? []).filter((r: any) => r.status === "sent");
  if (sentLogs.length >= MAX_ATTEMPTS) return { ok: false, nextAttempt: 0, reason: "max_attempts" };

  if (sentLogs.length > 0) {
    const lastAt = new Date(sentLogs[0].sent_at).getTime();
    const ageDays = (Date.now() - lastAt) / (1000 * 60 * 60 * 24);
    if (ageDays < MIN_DAYS_BETWEEN) return { ok: false, nextAttempt: 0, reason: "too_soon" };
  }
  return { ok: true, nextAttempt: sentLogs.length + 1 };
}

async function logReminder(
  admin: SendCtx["admin"],
  email: string,
  tenantId: string | null,
  type: ReminderType,
  attempt: number,
  status: "sent" | "failed",
  error?: string,
) {
  await admin.from("reminder_log").insert({
    email, tenant_id: tenantId, reminder_type: type, attempt, status, error: error ?? null,
  });
}

// Cap-Check: bricht den Loop ab, wenn das per-run-Limit für diesen Typ erreicht ist
function capReached(ctx: SendCtx, type: ReminderType): boolean {
  return (ctx.sentCountByType.get(type) ?? 0) >= MAX_SENDS_PER_RUN;
}
function bumpSent(ctx: SendCtx, type: ReminderType) {
  ctx.sentCountByType.set(type, (ctx.sentCountByType.get(type) ?? 0) + 1);
}

// ───── 1. Invite-Reminder ─────
async function runInvites(ctx: SendCtx) {
  // Akzeptierte Bewerbungen, älter als 3 Tage
  const cutoff = new Date(Date.now() - MIN_DAYS_BETWEEN * 86400_000).toISOString();
  const { data: apps, error } = await ctx.admin
    .from("applications")
    .select("id,email,full_name,first_name,last_name,tenant_id,status,created_at,updated_at")
    .eq("status", "akzeptiert")
    .lte("updated_at", cutoff);
  if (error) { console.error("invite query", error); return; }

  // Bestehende Auth-Accounts (Mail-Set) laden
  const { data: usersList } = await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 5000 });
  const existing = new Set<string>((usersList?.users ?? []).map(u => (u.email ?? "").toLowerCase()));

  for (const app of apps ?? []) {
    const email = (app.email ?? "").toLowerCase();
    if (!email || existing.has(email)) continue;

    const tenant = app.tenant_id ? ctx.tenants.get(app.tenant_id) : null;
    if (!tenant || !tenant.smtp_host) {
      ctx.results.push({ type: "invite", email, status: "skipped", error: "no_tenant_smtp" });
      continue;
    }

    const gate = await canSend(ctx.admin, email, "invite");
    if (!gate.ok) { ctx.results.push({ type: "invite", email, status: "skipped", error: gate.reason }); continue; }

    if (ctx.dryRun) { ctx.results.push({ type: "invite", email, status: "sent" }); continue; }

    const portalLink = `https://portal.${tenant.domain}/register`;
    const firstName = app.first_name ?? (app.full_name ?? "").split(" ")[0] ?? "";
    const html = renderInviteHtml(tenant, firstName, portalLink);
    const subject = `Erinnerung: Registrierung bei ${tenant.name} abschließen`;

    try {
      await sendMail(tenant, email, subject, html);
      await logReminder(ctx.admin, email, tenant.id, "invite", gate.nextAttempt, "sent");
      ctx.results.push({ type: "invite", email, status: "sent" });
    } catch (e: any) {
      await logReminder(ctx.admin, email, tenant.id, "invite", gate.nextAttempt, "failed", String(e?.message ?? e));
      ctx.results.push({ type: "invite", email, status: "failed", error: String(e?.message ?? e) });
    }
  }
}

// ───── 2. Confirm-Email-Reminder ─────
async function runConfirmEmail(ctx: SendCtx) {
  const { data: usersList } = await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 5000 });
  const unconfirmed = (usersList?.users ?? []).filter(u => !u.email_confirmed_at && u.email);

  // Profile für tenant_id-Lookup
  const userIds = unconfirmed.map(u => u.id);
  let tenantByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await ctx.admin
      .from("profiles")
      .select("user_id,tenant_id")
      .in("user_id", userIds);
    (profiles ?? []).forEach((p: any) => { if (p.tenant_id) tenantByUser.set(p.user_id, p.tenant_id); });
  }

  const cutoffMs = MIN_DAYS_BETWEEN * 86400_000;
  for (const u of unconfirmed) {
    const created = new Date(u.created_at!).getTime();
    if (Date.now() - created < cutoffMs) continue;

    const email = u.email!.toLowerCase();
    const tenantId = tenantByUser.get(u.id);
    const tenant = tenantId ? ctx.tenants.get(tenantId) : null;
    if (!tenant || !tenant.smtp_host) { ctx.results.push({ type: "confirm_email", email, status: "skipped", error: "no_tenant_smtp" }); continue; }

    const gate = await canSend(ctx.admin, email, "confirm_email");
    if (!gate.ok) { ctx.results.push({ type: "confirm_email", email, status: "skipped", error: gate.reason }); continue; }

    if (ctx.dryRun) { ctx.results.push({ type: "confirm_email", email, status: "sent" }); continue; }

    const redirectTo = `https://portal.${tenant.domain}/auth/confirmed`;
    const linkRes = await ctx.admin.auth.admin.generateLink({ type: "signup", email, options: { redirectTo } });
    const tokenHash = (linkRes.data?.properties as any)?.hashed_token;
    if (!tokenHash) {
      await logReminder(ctx.admin, email, tenant.id, "confirm_email", gate.nextAttempt, "failed", "no_token");
      ctx.results.push({ type: "confirm_email", email, status: "failed", error: "no_token" });
      continue;
    }
    const actionLink = `${redirectTo}?token_hash=${encodeURIComponent(tokenHash)}&type=signup`;
    const html = renderConfirmHtml(tenant, email, actionLink);
    const subject = `Bitte bestätige deine E-Mail – ${tenant.name}`;

    try {
      await sendMail(tenant, email, subject, html);
      await logReminder(ctx.admin, email, tenant.id, "confirm_email", gate.nextAttempt, "sent");
      ctx.results.push({ type: "confirm_email", email, status: "sent" });
    } catch (e: any) {
      await logReminder(ctx.admin, email, tenant.id, "confirm_email", gate.nextAttempt, "failed", String(e?.message ?? e));
      ctx.results.push({ type: "confirm_email", email, status: "failed", error: String(e?.message ?? e) });
    }
  }
}

// ───── 3. Complete-Registration-Reminder ─────
async function runCompleteRegistration(ctx: SendCtx) {
  const cutoff = new Date(Date.now() - MIN_DAYS_BETWEEN * 86400_000).toISOString();
  const { data: profiles, error } = await ctx.admin
    .from("profiles")
    .select("user_id,full_name,tenant_id,onboarding_status,updated_at,created_at")
    .neq("onboarding_status", "abgeschlossen")
    .lte("created_at", cutoff);
  if (error) { console.error("complete query", error); return; }

  const userIds = (profiles ?? []).map((p: any) => p.user_id);
  if (userIds.length === 0) return;
  const { data: usersList } = await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 5000 });
  const userMap = new Map<string, any>((usersList?.users ?? []).map(u => [u.id, u]));

  for (const p of profiles ?? []) {
    const u = userMap.get((p as any).user_id);
    if (!u || !u.email_confirmed_at || !u.email) continue; // nur bestätigte Accounts
    const email = u.email.toLowerCase();
    const tenant = (p as any).tenant_id ? ctx.tenants.get((p as any).tenant_id) : null;
    if (!tenant || !tenant.smtp_host) { ctx.results.push({ type: "complete_registration", email, status: "skipped", error: "no_tenant_smtp" }); continue; }

    const gate = await canSend(ctx.admin, email, "complete_registration");
    if (!gate.ok) { ctx.results.push({ type: "complete_registration", email, status: "skipped", error: gate.reason }); continue; }

    if (ctx.dryRun) { ctx.results.push({ type: "complete_registration", email, status: "sent" }); continue; }

    const firstName = ((p as any).full_name ?? "").split(" ")[0] ?? "";
    const loginLink = `https://portal.${tenant.domain}/login`;
    const html = renderCompletionHtml(tenant, firstName, loginLink);
    const subject = `Bitte schließe deine Registrierung ab – ${tenant.name}`;

    try {
      await sendMail(tenant, email, subject, html);
      await logReminder(ctx.admin, email, tenant.id, "complete_registration", gate.nextAttempt, "sent");
      ctx.results.push({ type: "complete_registration", email, status: "sent" });
    } catch (e: any) {
      await logReminder(ctx.admin, email, tenant.id, "complete_registration", gate.nextAttempt, "failed", String(e?.message ?? e));
      ctx.results.push({ type: "complete_registration", email, status: "failed", error: String(e?.message ?? e) });
    }
  }
}

// ───── 4. No-Recent-Booking-Reminder ─────
async function runNoRecentBooking(ctx: SendCtx) {
  const { data: profiles, error } = await ctx.admin
    .from("profiles")
    .select("user_id,full_name,tenant_id,onboarding_status,created_at")
    .eq("onboarding_status", "abgeschlossen");
  if (error) { console.error("no_booking query", error); return; }
  if (!profiles || profiles.length === 0) return;

  const userIds = profiles.map((p: any) => p.user_id);
  const cutoffIso = new Date(Date.now() - NO_BOOKING_DAYS * 86400_000).toISOString();

  const { data: recentBookings } = await ctx.admin
    .from("bookings")
    .select("user_id,created_at,status")
    .in("user_id", userIds)
    .gte("created_at", cutoffIso)
    .neq("status", "cancelled");
  const hasRecent = new Set<string>((recentBookings ?? []).map((b: any) => b.user_id));

  const { data: usersList } = await ctx.admin.auth.admin.listUsers({ page: 1, perPage: 5000 });
  const userMap = new Map<string, any>((usersList?.users ?? []).map(u => [u.id, u]));

  for (const p of profiles) {
    const uid = (p as any).user_id;
    if (hasRecent.has(uid)) continue;

    const u = userMap.get(uid);
    if (!u || !u.email || !u.email_confirmed_at) continue;

    const accountAgeMs = Date.now() - new Date(u.created_at!).getTime();
    if (accountAgeMs < NO_BOOKING_DAYS * 86400_000) continue;

    const email = u.email.toLowerCase();
    const tenant = (p as any).tenant_id ? ctx.tenants.get((p as any).tenant_id) : null;
    if (!tenant || !tenant.smtp_host) {
      ctx.results.push({ type: "no_recent_booking", email, status: "skipped", error: "no_tenant_smtp" });
      continue;
    }

    const gate = await canSend(ctx.admin, email, "no_recent_booking");
    if (!gate.ok) { ctx.results.push({ type: "no_recent_booking", email, status: "skipped", error: gate.reason }); continue; }

    if (ctx.dryRun) { ctx.results.push({ type: "no_recent_booking", email, status: "sent" }); continue; }

    const firstName = ((p as any).full_name ?? "").split(" ")[0] ?? "";
    const bookingLink = `https://portal.${tenant.domain}/appointments`;
    const html = renderNoBookingHtml(tenant, firstName, bookingLink);
    const subject = `Neue Aufträge warten auf dich – ${tenant.name}`;

    try {
      await sendMail(tenant, email, subject, html);
      await logReminder(ctx.admin, email, tenant.id, "no_recent_booking", gate.nextAttempt, "sent");
      ctx.results.push({ type: "no_recent_booking", email, status: "sent" });
    } catch (e: any) {
      await logReminder(ctx.admin, email, tenant.id, "no_recent_booking", gate.nextAttempt, "failed", String(e?.message ?? e));
      ctx.results.push({ type: "no_recent_booking", email, status: "failed", error: String(e?.message ?? e) });
    }
  }
}

// ───── Mailversand ─────
async function sendMail(tenant: TenantRow, to: string, subject: string, html: string) {
  const transporter = nodemailer.createTransport({
    host: tenant.smtp_host!,
    port: tenant.smtp_port!,
    secure: tenant.smtp_port === 465,
    auth: { user: tenant.smtp_username!, pass: tenant.smtp_password! },
  });
  const senderName = tenant.sender_name ?? tenant.name;
  const senderEmail = tenant.sender_email ?? tenant.smtp_username!;
  await transporter.sendMail({
    from: `"${senderName}" <${senderEmail}>`,
    to,
    replyTo: tenant.reply_to_email ?? senderEmail,
    subject,
    html,
  });
}

// ───── Templates ─────
function shellHtml(tenant: TenantRow, inner: string): string {
  const brand = tenant.primary_color ?? "#0f172a";
  const logo = tenant.logo_url
    ? `<img src="${tenant.logo_url}" alt="${escapeHtml(tenant.name)}" style="max-height:40px;margin-bottom:24px"/>`
    : `<div style="font-weight:700;font-size:20px;margin-bottom:24px;color:${brand}">${escapeHtml(tenant.name)}</div>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:40px;max-width:560px">
<tr><td>${logo}${inner}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0"/>
<p style="font-size:12px;color:#94a3b8;margin:0">Diese Erinnerung wurde automatisch versendet. Wenn du sie nicht mehr benötigst, kannst du sie ignorieren.</p>
</td></tr></table></td></tr></table></body></html>`;
}

function btn(brand: string, href: string, label: string): string {
  return `<table cellpadding="0" cellspacing="0"><tr><td style="background:${brand};border-radius:8px">
<a href="${href}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">${label}</a>
</td></tr></table>`;
}

function renderInviteHtml(t: TenantRow, firstName: string, link: string): string {
  const brand = t.primary_color ?? "#0f172a";
  const greet = firstName ? `Hallo ${escapeHtml(firstName)},` : "Hallo,";
  return shellHtml(t, `
<h1 style="font-size:22px;margin:0 0 16px;color:#0f172a">Erinnerung: Deine Registrierung wartet</h1>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px">${greet}</p>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 24px">deine Bewerbung bei <strong>${escapeHtml(t.name)}</strong> wurde bereits angenommen, aber du hast deinen Account noch nicht angelegt. Bitte schließe die Registrierung ab, damit es weitergehen kann.</p>
${btn(brand, link, "Jetzt registrieren")}
<p style="font-size:13px;color:#94a3b8;margin:24px 0 0">Oder kopiere diesen Link: <a href="${link}" style="color:${brand};word-break:break-all">${link}</a></p>`);
}

function renderConfirmHtml(t: TenantRow, email: string, link: string): string {
  const brand = t.primary_color ?? "#0f172a";
  return shellHtml(t, `
<h1 style="font-size:22px;margin:0 0 16px;color:#0f172a">Bitte bestätige deine E-Mail-Adresse</h1>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 24px">Wir haben deine Bestätigung für <strong>${escapeHtml(email)}</strong> noch nicht erhalten. Bitte bestätige deine E-Mail, damit du dich anmelden kannst.</p>
${btn(brand, link, "E-Mail bestätigen")}
<p style="font-size:13px;color:#94a3b8;margin:24px 0 0">Oder kopiere diesen Link: <a href="${link}" style="color:${brand};word-break:break-all">${link}</a></p>`);
}

function renderCompletionHtml(t: TenantRow, firstName: string, link: string): string {
  const brand = t.primary_color ?? "#0f172a";
  const greet = firstName ? `Hallo ${escapeHtml(firstName)},` : "Hallo,";
  return shellHtml(t, `
<h1 style="font-size:22px;margin:0 0 16px;color:#0f172a">Bitte schließe deine Registrierung ab</h1>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px">${greet}</p>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 24px">in deinem Account bei <strong>${escapeHtml(t.name)}</strong> fehlen noch ein paar Angaben (z.B. Personalausweis, Arbeitsvertrag oder Pflichtdaten). Bitte melde dich an und vervollständige dein Profil.</p>
${btn(brand, link, "Jetzt vervollständigen")}
<p style="font-size:13px;color:#94a3b8;margin:24px 0 0">Login: <a href="${link}" style="color:${brand}">${link}</a></p>`);
}

function renderNoBookingHtml(t: TenantRow, firstName: string, link: string): string {
  const brand = t.primary_color ?? "#0f172a";
  const greet = firstName ? `Hallo ${escapeHtml(firstName)},` : "Hallo,";
  return shellHtml(t, `
<h1 style="font-size:22px;margin:0 0 16px;color:#0f172a">Neue Aufträge warten auf dich</h1>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px">${greet}</p>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 24px">du hast seit über 7 Tagen keine Aufträge mehr bei <strong>${escapeHtml(t.name)}</strong> gebucht. Im Portal warten freie Termine — sichere dir jetzt deinen nächsten Einsatz.</p>
${btn(brand, link, "Aufträge ansehen")}
<p style="font-size:13px;color:#94a3b8;margin:24px 0 0">Oder kopiere diesen Link: <a href="${link}" style="color:${brand};word-break:break-all">${link}</a></p>`);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
