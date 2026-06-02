## Ziel

Wenn `portal.digital-dgigmbh.de` durch DENIC-Flag tot ist, sollen Bewerber & Mitarbeiter über eine Fallback-Domain (z.B. `digital-dgigmbh.com`) erreichbar bleiben — ohne Code-Deploy bei jeder Krise. Plus: Rettungs-Werkzeuge für bereits versendete Mails mit toten Links.

---

## Teil 1 — Multi-Domain pro Tenant (Fundament)

### Datenmodell
- Neue Tabelle `tenant_domains` (`id`, `tenant_id`, `domain`, `is_primary`, `created_at`)
- Migration: bestehende `tenants.domain`-Werte einmalig nach `tenant_domains` kopieren (jeweils als `is_primary=true`)
- `tenants.domain` bleibt vorerst als "primary cache" stehen → keine Breaking Changes für Alt-Code

### Lookup
- `get_public_tenant_by_domain(_domain)` matcht zusätzlich gegen `tenant_domains.domain`
- `getTenantDomain()` in `src/lib/domain-utils.ts` unverändert
- `TenantContext` & `useTenantByDomain` profitieren automatisch

### Admin-UI
- Auf `/admin/tenants` Erweiterung des Tenant-Editors:
  - Liste aller Domains des Tenants
  - Button "+ Domain hinzufügen" (z.B. `portal.digital-dgigmbh.com`)
  - Radio "Primary" — definiert die Domain, die in **neuen** Mails als Portal-URL erscheint
  - Domain löschen (außer Primary)

### Mail-Versand
- Reminder-Edge-Function (`send-reminders`) und alle Mail-Templates verwenden zentral eine Helper-Funktion `getTenantPortalUrl(tenant)` die immer die aktuelle Primary-Domain auflöst
- Wechsel der Primary-Domain → ab sofort gehen alle neuen Mails über die neue Domain raus, **ohne Deploy**

---

## Teil 2 — Rettungs-Toolkit für alte Mails

Vier Werkzeuge, alle optional kombinierbar:

### A) Bulk-Re-Send (Admin-Button)
- Neue Admin-Seite `/admin/recovery` oder Button auf `/admin/reminders`
- "Alle aktiven Empfänger mit neuer Portal-URL anschreiben"
- Filter: nur Empfänger mit Status ≠ `abgeschlossen` (Bewerber: ≠ `abgelehnt`)
- Rate-Limit: gleicher 600/12h-Mechanismus wie Reminder
- Eigener Template-Typ `domain_recovery` → eigene Quota, blockiert nicht den normalen Reminder-Strom
- Vorschau zeigt: "187 Empfänger werden über die nächsten ~4 Stunden angeschrieben"

### B) Magic-Login-Generator (manuelle Rettungsleine)
- Auf jedem Bewerber/Mitarbeiter-Detail eine neue Action "Login-Link generieren"
- Erzeugt einmaligen Token in neuer Tabelle `magic_login_tokens` (24h gültig, single-use)
- Token ist Link auf Fallback-Domain: `https://portal.digital-dgigmbh.com/login?magic=<token>`
- Server-Route `/api/public/magic-login` validiert Token, erzeugt Supabase-Session, redirected
- Admin kopiert Link, verschickt per WhatsApp/Telefon — Bewerber klickt, ist eingeloggt

### C) WhatsApp-Fallback (optional, nur wenn gewünscht)
- Voraussetzung: pro Empfänger gepflegte Telefonnummer + WhatsApp-Business-Setup
- Eigene Edge-Function `send-whatsapp-recovery`
- **Nicht Teil dieses Plans** — separat besprechen, wenn nötig

### D) DNS-Catch-All-Hinweis (kein Code)
- Wenn `.de` wiederkommt: am Registrar einen 301-Redirect von `portal.digital-dgigmbh.de` → `portal.digital-dgigmbh.com` einrichten (oder umgekehrt)
- Sicherheitsnetz für Bookmark-Reste, nicht für die akute Krise

---

## Empfehlung

**Sofort umsetzen:** Teil 1 + A + B
- Teil 1 macht zukünftige Krisen lösbar ohne Code-Deploy
- A fängt 80% der bestehenden Empfänger automatisch ab
- B ist die manuelle Notfall-Lösung für VIP-Leads

**Später bei Bedarf:** C (WhatsApp)

---

## Technische Details

### Neue Dateien
- `supabase/migrations/<timestamp>_tenant_domains.sql` — Tabelle, RLS, Backfill
- `supabase/migrations/<timestamp>_magic_login_tokens.sql` — Token-Tabelle, Cleanup-Trigger
- `src/lib/tenant-domain.functions.ts` — Server-Fns: addDomain, removeDomain, setPrimary
- `src/lib/magic-login.functions.ts` — Server-Fn: generateMagicLink (Admin only)
- `src/lib/recovery.functions.ts` — Server-Fn: enqueueDomainRecoveryMails
- `src/routes/api/public/magic-login.ts` — Token einlösen, Session setzen
- `src/routes/admin.recovery.tsx` — Recovery-Dashboard

### Geänderte Dateien
- `src/lib/domain-utils.ts` — keine Änderung (Helper bleibt)
- `src/contexts/TenantContext.tsx`, `src/hooks/use-tenant.ts` — nutzen erweiterte RPC
- `src/routes/admin.tenants.tsx` — Domain-Verwaltung-UI
- `src/routes/admin.employees.$userId.tsx` + `admin.applications.$appId.tsx` — Button "Login-Link generieren"
- `supabase/functions/send-reminders/index.ts` — `getTenantPortalUrl()` statt hartkodiertem `portal.<domain>`
- Alle E-Mail-Templates (Reminder, Welcome, Contract, etc.) — Portal-URL über Helper

### Sicherheit
- `tenant_domains` mit RLS: nur Admins ihres Tenants dürfen lesen/schreiben
- `magic_login_tokens`: einmalig, max. 24h, Status-Spalte (`unused`/`used`/`expired`)
- Magic-Login server-side: rate-limit (max 10 Tokens/Bewerber/Tag), Audit-Log-Eintrag
- Recovery-Bulk-Send: max. 1× pro 24h pro Tenant, vorher Vorschau-Pflicht

### Was NICHT geändert wird
- Bestehender Reminder-Mechanismus, SMTP-Validierung, Quiet Hours, 600/12h-Quota → unverändert
- `tenants.domain`-Spalte bleibt (für Backward-Compat) — wird vom Server bei Primary-Change automatisch gespiegelt
- Keine UI-Änderungen außerhalb Admin-Bereich

---

## Reihenfolge der Umsetzung

1. Schema-Migrations (tenant_domains, magic_login_tokens)
2. Lookup-RPC erweitern, Mail-Helper `getTenantPortalUrl`
3. Admin-UI für Domain-Verwaltung
4. Magic-Login-Generator + Public-Route
5. Recovery-Dashboard + Bulk-Re-Send
6. Reminder-Function auf Helper umstellen
7. Test mit Test-Tenant, dann Deploy

Nach Deploy: du registrierst `.com`, fügst sie im Admin-UI hinzu, machst sie zur Primary → ab dem Moment fließen alle neuen Mails über `.com`. Mit "Bulk-Re-Send" werden die 187 Alt-Empfänger gestaffelt neu angeschrieben.
