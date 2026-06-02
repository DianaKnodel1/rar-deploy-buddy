import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Schema = z.object({
  user_id: z.string().uuid(),
  // Welche Domain soll im Login-Link verwendet werden? (z.B. "digital-dgigmbh.com")
  // Wird automatisch "portal." vorangestellt.
  portal_domain: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/i),
  // Optionaler Pfad nach Login (default: /dashboard)
  redirect_path: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/).optional(),
});

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase
    .from("user_roles").select("role")
    .eq("user_id", ctx.userId).eq("role", "admin").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Nicht autorisiert");
}

/**
 * Generiert einen einmaligen Magic-Login-Link für einen Bewerber/Mitarbeiter.
 * Der Admin kann den Link manuell weiterleiten (WhatsApp, Telefon, alternative Mail)
 * — Notfall-Werkzeug für tote/blockierte Portal-Domains.
 *
 * Nutzt Supabase Auth Admin `generateLink({ type: 'magiclink' })`.
 * Der Link ist standardmäßig ~1h gültig und einmalig einlösbar.
 */
export const generateAdminMagicLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => Schema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const sb = supabaseAdmin as any;

    // 1) E-Mail des Ziel-Users holen (über auth.admin, da profiles evtl. keine email speichert)
    const { data: userRes, error: uErr } = await sb.auth.admin.getUserById(data.user_id);
    if (uErr) throw new Error(uErr.message);
    const email: string | undefined = userRes?.user?.email;
    if (!email) throw new Error("Empfänger hat keine E-Mail-Adresse im Auth-System");

    // 2) Redirect-URL zusammenbauen — IMMER auf die vom Admin gewählte Domain
    const cleanDomain = data.portal_domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const host = cleanDomain.startsWith("portal.") ? cleanDomain : `portal.${cleanDomain}`;
    const path = data.redirect_path ?? "/dashboard";
    const redirectTo = `https://${host}${path}`;

    // 3) Magic-Link generieren (nicht versenden — Admin kopiert manuell)
    const { data: linkRes, error: lErr } = await sb.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (lErr) throw new Error(lErr.message);
    const actionLink: string | undefined = linkRes?.properties?.action_link;
    if (!actionLink) throw new Error("Magic-Link konnte nicht erzeugt werden");

    // 4) Audit-Log
    try {
      await sb.from("activity_log").insert({
        action: "magic_login_link_generiert",
        entity_type: "profile",
        entity_id: data.user_id,
        actor_id: context.userId,
        comment: `Login-Link erzeugt für ${email} → ${host}${path}`,
      });
    } catch {}

    return { action_link: actionLink, email, host, redirectTo };
  });