# IAC Media Operations

A media team coordination app for the Imam Ali Center (IAC). It includes a local development demo and a Supabase-backed mode. The interface identifies demo data clearly and never treats demo sign-in as real authentication.

## What works

- Responsive operations dashboard with role-specific event, readiness, assignment, checklist, equipment, and incident summaries.
- Event creation, editing, schedule publishing, local event times, public details, and private production notes.
- Role assignments with overlap checks, in-app notices, acknowledgment, and automatically generated role checklists.
- Equipment inventory and person-based loans. The checkout crew records the borrower, handoff condition, optional due date, and notes before handing the item over in person; return inspections update availability and maintenance status.
- Required checklist completion and failure reporting with a note; failed checks remain a readiness issue until resolved.
- Search across authorized visible records, SOP drafts and publishing review, incident reporting/resolution, content stage transitions, reports, and CSV export.
- Supabase Auth session cookies, server-side authorization checks, normalized migrations, RLS, and transactional database functions for connected mode.
- Audit history for important operations.

The 15 technical SOP examples are draft templates. The templates deliberately avoid IAC-specific wiring, addresses, passwords, or equipment configuration. A generic incident-reporting guide is included as a published example. A director must confirm technical review before publishing draft procedures.

## Run locally

Requirements: Node.js 20.9 or newer and npm.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. This repository intentionally includes no team accounts or IAC operational records. Existing local accounts and data stay in the ignored `.local` directory and are not published. Connect Supabase and provision the first administrator for a new deployment; use only a trusted local data directory for local demo mode.

Demo mode is rejected by the app in production. It is intended for a trusted local machine and must not be exposed as a shared volunteer login.

## Connect Supabase

1. Create a Supabase project and keep public signups disabled unless the organization explicitly wants open registration.
2. In the Supabase SQL Editor, apply the files in this order:
   - `supabase/migrations/202610250001_core_schema.sql`
   - `supabase/migrations/202610250002_security_workflows.sql`
   - `supabase/migrations/202610250003_rls_policies.sql`
   - `supabase/migrations/202610250004_person_equipment_loans.sql`
   - `supabase/migrations/202610260005_team_account_management.sql`
3. Copy the project URL and publishable/anon key into `.env.local`:

   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-key
   SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
   NEXT_PUBLIC_SITE_URL=http://localhost:3000
   DEMO_MODE=false
   ```

   Keep `SUPABASE_SERVICE_ROLE_KEY` private in the server environment. It is used only by administrator account-management routes and must never be given a `NEXT_PUBLIC_` prefix.

4. Create the first account through the Supabase Auth dashboard. The auth trigger creates a profile with the least-privileged `Operator` role.
5. Promote the initial administrator from the Supabase SQL Editor, using the verified account email to identify the correct Auth user. Review the selected row before running the update:

   ```sql
   select id, email from auth.users where email = 'admin@example.org';
   update public.profiles
   set role = 'Administrator'
   where id = 'PASTE_THE_VERIFIED_USER_UUID_HERE';
   ```

   The SQL editor is the one-time trusted setup path. Ordinary authenticated users cannot elevate their own role. Later users can be invited from the Team page by an administrator; choose a username, email, production position, access role, and optional photo link. Supabase sends a password setup link, and administrators can update names, usernames, positions, access roles, sign-in emails, photos, active status, and send a fresh setup link.
6. Configure Supabase Auth email delivery and add your local and deployed app URLs to the allowed redirect URLs. The app returns invitation and recovery links through `/auth/callback` to `/set-password`. Restart the app after changing environment variables.

Only the publishable/anon key is public. The service-role key stays on the server and is used only after an administrator session is verified. RLS remains enabled for all operational tables.

Events default to the user's browser IANA timezone when created. The timezone is stored on the event and is used for assignment overlap checks. Equipment loans are person-based and do not depend on an event or its schedule.

## Checks

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

The automated suite includes a local API integration pass for protected routes, role restrictions, event updates, assignments and acknowledgments, checklist failures, equipment handoffs to named borrowers and return inspections, SOP publication, incident resolution, content transitions, logout, and audit history. It exercises the local demo backend; it does not certify a separately configured Supabase project.

## Deploy

Deploy the project to Vercel or another Node.js host that supports Next.js. Apply the migrations to the production Supabase project first. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `DEMO_MODE=false` in the host's environment configuration. Configure Auth redirect URLs for the production domain, use HTTPS, and test the RLS policies with accounts for each role before inviting volunteers.

Keep database backups enabled in Supabase and periodically verify that a backup can be restored. Export sensitive reports only to an approved location. Uploaded media files are not stored in this app; content records hold external storage links.

## Current release limits

- Event calendar is a list view; recurring schedules and event-template editing are not available yet.
- Equipment is borrowed by a named person and tracked through return; reusable role-specific equipment kits are not implemented yet.
- Qualification approvals, training sign-off, reusable checklist authoring, and announcement management are not exposed in the UI.
- The training page shows published reading resources and qualification status; it does not record quizzes or supervisor assessments.
- Equipment QR scanning, file uploads, private Supabase Storage buckets, email/push delivery, and offline synchronization are not implemented.
- Reports currently cover visible event counts, assignment responses, checklist completion, incidents, and event CSV export. Equipment utilization and historical trend charts are not included.
- No Supabase project credentials or team email addresses were provided, so the local username/password accounts are not connected to a live IAC service. Real invitations require that connection and each member's email. Connected authentication and RLS migrations have not been exercised against a live IAC database.

