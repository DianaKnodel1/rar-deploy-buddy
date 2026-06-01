# Reminder-System

## Ziel

Drei Zustände bekommen automatisch (alle 3 Tage, max. 5 Mails) eine Erinnerung:

1. **Bewerber akzeptiert, kein Account** — Willkommensmail erneut senden (auch wenn schon mal gesendet)
2. **Account angelegt, E-Mail nicht bestätigt** — Confirmation-Mail erneut
3. **Account bestätigt, Registrierung unvollständig** (Personalausweis, Vertrag, Pflichtfelder fehlen) — Erinnerung "Bitte abschließen"
4. **Mitarbeiter ohne Buchung seit 7+ Tagen** — Erinnerung "Neue Aufträge warten auf dich"

Sequenz pro Zustand: Tag 3, 6, 9, 12, 15 nach dem letzten relevanten Event. Danach Stopp.

## Umsetzung

### 1. Migration: `reminder_log`

```sql
create table public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  tenant_id uuid references public.tenants(id) on delete cascade,
  reminder_type text not null,        -- 'invite' | 'confirm_email' | 'complete_registration'
  attempt int not null,               -- 1..5
  sent_at timestamptz not null default now(),
  status text not null default 'sent',-- 'sent' | 'failed' | 'skipped'
  error text
);
create index on public.reminder_log (email, reminder_type, sent_at desc);
grant select, insert on public.reminder_log to service_role;
alter table public.reminder_log enable row level security;
create policy "service only" on public.reminder_log for all to service_role using (true);
```

### 2. Neue Edge Function `send-reminders`

- Wird per `pg_cron` 1×/Tag um 09:00 Europe/Berlin getriggert (HTTP-Call gegen die Function).
- Logik je Typ:
  - **invite**: `applications` mit `status='akzeptiert'` JOIN `auth.users` LEFT — nur wo kein User existiert. Reuse von `send-invitation-email`-HTML, schreibt `reminder_log`.
  - **confirm_email**: `auth.users` mit `email_confirmed_at IS NULL` → ruft intern `resend-signup-confirmation` Logik auf.
  - **complete_registration**: `profiles` wo `onboarding_status != 'completed'` AND `email_confirmed_at IS NOT NULL` → branded Reminder-Mail mit Link `/onboarding`.
- Gates pro Mail:
  - count(reminder_log) < 5
  - last sent > 3 Tage her
  - relevantes Event (Annahme / Account-Erstellung / Bestätigung) > 3 Tage her

### 3. pg_cron Job (in Migration)

```sql
select cron.schedule(
  'send-reminders-daily', '0 8 * * *',
  $$ select net.http_post(
       url := 'https://<supabase-url>/functions/v1/send-reminders',
       headers := jsonb_build_object('Authorization','Bearer <service-role>')
     ); $$
);
```

(Service-Role-Key wird über Vault gelesen, nicht inline.)

### 4. Admin-Button "Alt-Bewerber re-inviten"

In `/admin/applications`: Button **"Erinnerungen jetzt senden"** der die Function manuell triggert (für den initialen Sweep der ~150 Bewerber).

### 5. Mail-Templates (in der Function inline, im Stil der bestehenden Mails)

- **invite-reminder**: "Erinnerung: Deine Registrierung wartet auf dich" + Portal-Link
- **confirm-reminder**: "Bitte bestätige deine E-Mail" + neuer Confirmation-Link
- **completion-reminder**: "Bitte schließe deine Registrierung ab — es fehlen noch: {liste}" + Login-Link

## Was nach Approval passiert

1. Migration mit `reminder_log` + cron schedule
2. Edge Function `supabase/functions/send-reminders/index.ts` (modular, drei Handler)
3. Admin-Button im Bewerbungs-Screen
4. Deploy-Hinweis: `supabase functions deploy send-reminders --no-verify-jwt` + `pg_cron`/`pg_net` Extensions aktivieren

## Offene Punkte (bitte bestätigen)

- **Intervall**: Tag 3, 6, 9, 12, 15 — okay so, oder anders staffeln (z.B. 3/5/8/12/15)?
- **Sendezeit**: 09:00 Europe/Berlin?
- **Stop-Bedingungen**: Soll bei Status `abgelehnt` oder gelöschter Bewerbung sofort gestoppt werden? (Default: ja)
- **Initialer Sweep**: Sollen die ~150 Alt-Bewerber alle auf einmal eine Mail bekommen, oder über die normale Cron-Mechanik gestaffelt (Tag 1 = alle die seit >3 Tagen akzeptiert sind)?
