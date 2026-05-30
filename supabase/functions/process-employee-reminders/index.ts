// Deno Edge Function: process-employee-reminders
//
// Versendet automatische Erinnerungs-Mails an Mitarbeiter.
// Zwei Sequenzen:
//   1) incomplete – Registrierung noch nicht abgeschlossen
//                   (E-Mail nicht bestätigt ODER KYC nicht verifiziert
//                    ODER Vertrag nicht unterschrieben)
//      Anker: profiles.created_at
//   2) inactive   – Aktiv (status=angenommen, KYC=verifiziert, Vertrag signiert),
//                   aber keine task_assignments-Aktivität in den letzten 7 Tagen
//      Anker: latest(contract_signed_at, max(task_assignments.updated_at)) + 7 Tage
//
// Pro Sequenz max. 5 Mails, alle 3 Tage (Tag 3,6,9,12,15 nach Anker).
// Mails werden über die Tenant-SMTP des jeweiligen Mitarbeiters verschickt.
//
// Aufruf: täglich via pg_cron (siehe Migration) oder manuell via Service-Role JWT.
// Deploy: supabase functions deploy process-employee-reminders --no-verify-jwt

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import nodemailer from "https://esm.sh/nodemailer@6.9.14";

const STEP_DAYS = 3;
const MAX_STEPS = 5;
const INACTIVE_GRACE_DAYS = 7;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Tenant {
  id: string;
  name: string;
  domain: string;
  logo_url: string | null;
  primary_color: string | null;
  sender_email: string | null;
  sender_name: string | null;
  reply_to_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  smtp_password: string | null;
  reminder_welcome_subject: string | null;
  reminder_welcome_body: string | null;
  reminder_welcome_cta: string | null;
  reminder_incomplete_subject: string | null;
  reminder_incomplete_body: string | null;
  reminder_incomplete_cta: string | null;
  reminder_inactive_subject: string | null;
  reminder_inactive_body: string | null;
  reminder_inactive_cta: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const now = new Date();
  const result = { processed: 0, sent: 0, skipped: 0, errors: [] as string[] };

  try {
    // Admin-User-IDs ausschließen
    const { data: adminRoles } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");
    const adminIds = new Set((adminRoles ?? []).map((r: any) => r.user_id));

    // Alle Profile mit Tenant laden
    const { data: profiles, error: pErr } = await admin
      .from("profiles")
      .select("user_id, full_name, tenant_id, status, contract_signed_at, created_at");
    if (pErr) throw pErr;

    // Auth-Users (für E-Mail + email_confirmed_at)
    const { data: usersList, error: uErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
    if (uErr) throw uErr;
    const userMap = new Map(usersList.users.map((u) => [u.id, u]));

    // KYC + Tenants + bisherige Reminder + letzte Task-Aktivität in Bulk laden
    const { data: kycRows } = await admin.from("kyc_verifications").select("user_id, status");
    const kycMap = new Map((kycRows ?? []).map((k: any) => [k.user_id, k.status]));

    const profileTenantIds = (profiles ?? []).map((p: any) => p.tenant_id).filter(Boolean);

    const { data: logRows } = await admin
      .from("employee_reminder_log")
      .select("user_id, application_id, sequence, step");
    const logMap = new Map<string, Record<string, number>>();
    const appLogMap = new Map<string, Record<string, number>>();
    for (const r of logRows ?? []) {
      if (r.user_id) {
        const cur = logMap.get(r.user_id as string) ?? {};
        cur[r.sequence] = Math.max(cur[r.sequence] ?? 0, r.step);
        logMap.set(r.user_id as string, cur);
      }
      if (r.application_id) {
        const cur = appLogMap.get(r.application_id as string) ?? {};
        cur[r.sequence] = Math.max(cur[r.sequence] ?? 0, r.step);
        appLogMap.set(r.application_id as string, cur);
      }
    }

    // E-Mails bereits registrierter Auth-User (für Welcome-Skip)
    const registeredEmails = new Set(
      usersList.users.map((u) => (u.email ?? "").toLowerCase()).filter(Boolean),
    );

    // Akzeptierte Bewerbungen für Welcome-Sequenz
    const { data: acceptedApps } = await admin
      .from("applications")
      .select("id, full_name, first_name, email, tenant_id, status, created_at")
      .eq("status", "akzeptiert");

    const appTenantIds = (acceptedApps ?? []).map((a: any) => a.tenant_id).filter(Boolean);
    const tenantIds = [...new Set([...profileTenantIds, ...appTenantIds])];
    const { data: tenants } = await admin
      .from("tenants")
      .select("id,name,domain,logo_url,primary_color,sender_email,sender_name,reply_to_email,smtp_host,smtp_port,smtp_username,smtp_password,reminder_welcome_subject,reminder_welcome_body,reminder_welcome_cta,reminder_incomplete_subject,reminder_incomplete_body,reminder_incomplete_cta,reminder_inactive_subject,reminder_inactive_body,reminder_inactive_cta")
      .in("id", tenantIds as string[]);
    const tenantMap = new Map((tenants ?? []).map((t: any) => [t.id, t as Tenant]));


    // Letzte Auftrags-Aktivität pro User
    const { data: taskRows } = await admin
      .from("task_assignments")
      .select("user_id, updated_at");
    const lastActivity = new Map<string, Date>();
    for (const t of taskRows ?? []) {
      const cur = lastActivity.get(t.user_id as string);
      const u = new Date(t.updated_at as string);
      if (!cur || u > cur) lastActivity.set(t.user_id as string, u);
    }

    for (const p of profiles ?? []) {
      const userId = p.user_id as string;
      if (adminIds.has(userId)) { result.skipped++; continue; }

      const authUser = userMap.get(userId);
      const email = authUser?.email;
      if (!email) { result.skipped++; continue; }

      const tenant = p.tenant_id ? tenantMap.get(p.tenant_id) : null;
      if (!tenant || !tenant.smtp_host || !tenant.smtp_username || !tenant.smtp_password) {
        result.skipped++;
        continue;
      }

      const emailConfirmed = !!authUser?.email_confirmed_at;
      const kycVerified = kycMap.get(userId) === "verifiziert";
      const contractSigned = !!p.contract_signed_at;
      const accepted = p.status === "angenommen";
      const isComplete = emailConfirmed && kycVerified && contractSigned && accepted;

      // Leads (Bewerber, noch nicht angenommen) bekommen KEINE Erinnerungs-Mails.
      // Sequenz "incomplete" läuft nur für bereits angenommene Mitarbeiter,
      // denen noch KYC oder Vertragsunterschrift fehlt.
      if (!accepted) { result.skipped++; continue; }

      let sequence: "incomplete" | "inactive";
      let anchor: Date;

      if (!isComplete) {
        sequence = "incomplete";
        anchor = new Date(p.created_at as string);
      } else {
        const lastActive = lastActivity.get(userId);
        const baseDate = lastActive ?? new Date(p.contract_signed_at as string);
        anchor = new Date(baseDate.getTime() + INACTIVE_GRACE_DAYS * 86400000);
        if (now < anchor) { result.skipped++; continue; }
        sequence = "inactive";
      }

      const sentSoFar = logMap.get(userId)?.[sequence] ?? 0;
      const nextStep = sentSoFar + 1;
      if (nextStep > MAX_STEPS) { result.skipped++; continue; }

      const dueAt = new Date(anchor.getTime() + nextStep * STEP_DAYS * 86400000);
      if (now < dueAt) { result.skipped++; continue; }

      result.processed++;

      try {
        await sendReminder({
          tenant,
          email,
          fullName: (p.full_name as string) ?? "",
          sequence,
          step: nextStep,
          openItems: openItemsFor(emailConfirmed, kycVerified, contractSigned),
        });
        await admin.from("employee_reminder_log").insert({
          user_id: userId,
          tenant_id: tenant.id,
          sequence,
          step: nextStep,
          status: "sent",
        });
        result.sent++;
      } catch (err: any) {
        console.error(`Reminder failed for ${email}:`, err);
        result.errors.push(`${email}: ${err?.message ?? err}`);
        await admin.from("employee_reminder_log").insert({
          user_id: userId,
          tenant_id: tenant.id,
          sequence,
          step: nextStep,
          status: "failed",
          error: String(err?.message ?? err).slice(0, 500),
        });
      }
    }

    // ---------- Welcome-Sequenz für akzeptierte Bewerbungen ----------
    for (const a of acceptedApps ?? []) {
      const appId = a.id as string;
      const appEmail = (a.email as string | null)?.trim();
      if (!appEmail) { result.skipped++; continue; }

      // Wenn sich der Bewerber bereits im Portal registriert hat → kein Welcome-Reminder
      if (registeredEmails.has(appEmail.toLowerCase())) { result.skipped++; continue; }

      const tenant = a.tenant_id ? tenantMap.get(a.tenant_id) : null;
      if (!tenant || !tenant.smtp_host || !tenant.smtp_username || !tenant.smtp_password) {
        result.skipped++;
        continue;
      }

      const sentSoFar = appLogMap.get(appId)?.["welcome"] ?? 0;
      const nextStep = sentSoFar + 1;
      if (nextStep > MAX_STEPS) { result.skipped++; continue; }

      const anchor = new Date(a.created_at as string);
      const dueAt = new Date(anchor.getTime() + nextStep * STEP_DAYS * 86400000);
      if (now < dueAt) { result.skipped++; continue; }

      result.processed++;
      try {
        await sendReminder({
          tenant,
          email: appEmail,
          fullName: (a.full_name as string) ?? (a.first_name as string) ?? "",
          sequence: "welcome",
          step: nextStep,
          openItems: [],
        });
        await admin.from("employee_reminder_log").insert({
          application_id: appId,
          tenant_id: tenant.id,
          sequence: "welcome",
          step: nextStep,
          status: "sent",
        });
        result.sent++;
      } catch (err: any) {
        console.error(`Welcome reminder failed for ${appEmail}:`, err);
        result.errors.push(`${appEmail}: ${err?.message ?? err}`);
        await admin.from("employee_reminder_log").insert({
          application_id: appId,
          tenant_id: tenant.id,
          sequence: "welcome",
          step: nextStep,
          status: "failed",
          error: String(err?.message ?? err).slice(0, 500),
        });
      }
    }


    return json({ success: true, ...result }, 200);
  } catch (err: any) {
    console.error("process-employee-reminders fatal:", err);
    return json({ error: err?.message ?? "Unknown error", ...result }, 500);
  }
});

function openItemsFor(emailConfirmed: boolean, kycVerified: boolean, contractSigned: boolean): string[] {
  const items: string[] = [];
  if (!emailConfirmed) items.push("E-Mail-Adresse bestätigen");
  if (!kycVerified) items.push("Personalausweis hochladen (Identitätsprüfung)");
  if (!contractSigned) items.push("Arbeitsvertrag digital unterschreiben");
  return items;
}

async function sendReminder(opts: {
  tenant: Tenant;
  email: string;
  fullName: string;
  sequence: "incomplete" | "inactive" | "welcome";
  step: number;
  openItems: string[];
}) {
  const { tenant, email, fullName, sequence, step, openItems } = opts;
  const senderName = tenant.sender_name ?? tenant.name;
  const senderEmail = tenant.sender_email ?? tenant.smtp_username!;
  const brand = tenant.primary_color ?? "#0f172a";
  const firstName = (fullName.trim().split(/\s+/)[0]) || "zusammen";
  const portalUrl = `https://${tenant.domain}`;
  const registerUrl = `https://portal.${tenant.domain}/register`;

  let subject: string;
  let intro: string;
  let body: string;
  let ctaUrl = portalUrl;
  let ctaLabel = "Zum Portal";

  if (sequence === "welcome") {
    subject = tenant.reminder_welcome_subject || `Erinnerung ${step}/5: Willkommen – starte jetzt deine Registrierung – ${tenant.name}`;
    intro = "schön, dass du Teil unseres Teams werden möchtest – deine Bewerbung wurde bereits angenommen.";
    body = tenant.reminder_welcome_body || `Damit wir dich offiziell einbinden können, fehlt nur noch deine Registrierung im Mitarbeiter-Portal (E-Mail bestätigen, Identitätsprüfung, Arbeitsvertrag).`;
    ctaUrl = registerUrl;
    ctaLabel = tenant.reminder_welcome_cta || "Jetzt registrieren";
  } else if (sequence === "incomplete") {
    subject = tenant.reminder_incomplete_subject || `Erinnerung ${step}/5: Bitte schließe deine Registrierung ab – ${tenant.name}`;
    intro = "deine Registrierung ist noch nicht vollständig.";
    const tplBody = tenant.reminder_incomplete_body;
    const itemsHtml = openItems.length
      ? `<ul style="padding-left:18px;margin:8px 0">${openItems.map((i) => `<li style="margin:4px 0">${escapeHtml(i)}</li>`).join("")}</ul>`
      : "";
    body = tplBody
      ? (tplBody.includes("{{open_items}}") ? tplBody.replace(/\{\{open_items\}\}/g, itemsHtml) : `${tplBody}${itemsHtml}`)
      : (openItems.length
        ? `Folgende Schritte stehen noch aus:${itemsHtml}`
        : `Es fehlen noch ein paar persönliche Angaben in deinem Profil (z. B. IBAN, Steuer-Nr., SV-Nr.).`);
    ctaLabel = tenant.reminder_incomplete_cta || "Zum Portal";
  } else {
    subject = tenant.reminder_inactive_subject || `Erinnerung ${step}/5: Starte mit deinen ersten Aufträgen – ${tenant.name}`;
    intro = "wir haben gesehen, dass du dich erfolgreich registriert hast, aber seit über 7 Tagen keinen Auftrag mehr gebucht hast.";
    body = tenant.reminder_inactive_body || `Im Mitarbeiter-Portal kannst du jetzt einen neuen Termin buchen und mit dem nächsten Auftrag starten.`;
    ctaLabel = tenant.reminder_inactive_cta || "Termin buchen";
  }

  // Platzhalter im Body/Subject ersetzen
  const replace = (s: string) => s
    .replace(/\{\{first_name\}\}/g, escapeHtml(firstName))
    .replace(/\{\{full_name\}\}/g, escapeHtml(fullName))
    .replace(/\{\{tenant_name\}\}/g, escapeHtml(tenant.name))
    .replace(/\{\{step\}\}/g, String(step))
    .replace(/\{\{max_steps\}\}/g, String(MAX_STEPS));
  subject = replace(subject);
  body = replace(body);

  const logo = tenant.logo_url
    ? `<img src="${tenant.logo_url}" alt="${escapeHtml(tenant.name)}" style="max-height:40px;margin-bottom:24px"/>`
    : `<div style="font-weight:700;font-size:20px;margin-bottom:24px;color:${brand}">${escapeHtml(tenant.name)}</div>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:40px;max-width:560px">
<tr><td>
${logo}
<h1 style="font-size:22px;margin:0 0 16px;color:#0f172a">Hallo ${escapeHtml(firstName)},</h1>
<p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px">${escapeHtml(intro)}</p>
<div style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 24px">${body}</div>
<table cellpadding="0" cellspacing="0"><tr><td style="background:${brand};border-radius:8px">
<a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(ctaLabel)}</a>
</td></tr></table>
<p style="font-size:13px;color:#94a3b8;margin:32px 0 0;line-height:1.5">
Bei Fragen antworte einfach auf diese E-Mail – wir helfen dir gerne weiter.
</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0"/>
<p style="font-size:12px;color:#94a3b8;margin:0">
Diese E-Mail wurde an ${escapeHtml(email)} gesendet (Erinnerung ${step} von ${MAX_STEPS}).
</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const transporter = nodemailer.createTransport({
    host: tenant.smtp_host!,
    port: tenant.smtp_port!,
    secure: tenant.smtp_port === 465,
    auth: { user: tenant.smtp_username!, pass: tenant.smtp_password! },
  });

  await transporter.sendMail({
    from: `"${senderName}" <${senderEmail}>`,
    to: email,
    replyTo: tenant.reply_to_email ?? senderEmail,
    subject,
    html,
  });
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
