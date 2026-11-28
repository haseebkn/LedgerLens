import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { closePool, createPool, withTenantContext } from "./client.js";
import { embedTexts, toPgVectorLiteral } from "./embeddings.js";
import { runMigrations } from "./migrate.js";

/**
 * Idempotently loads the deterministic synthetic advisor book JSON produced by
 * `scripts/seed/generate_advisor_book.py` into Postgres + pgvector.
 *
 * Every tenant-scoped insert runs inside `withTenantContext` for that advisor,
 * proving that even seeding respects Row-Level Security with no bypass clause.
 */

export interface AdvisorBookData {
  meta: { synthetic: boolean; seed: number; as_of_date: string; notice: string };
  firms: { firm_id: string; name: string; is_synthetic: boolean }[];
  advisors: { advisor_id: string; firm_id: string; name: string; email: string; auth_subject: string }[];
  households: {
    household_id: string; firm_id: string; advisor_id: string; name: string;
    primary_email: string; phone: string | null; address: string; risk_profile: string;
    target_equity_pct: number; target_fixed_income_pct: number; target_cash_pct: number;
    last_review_date: string; next_review_date: string | null; notes_summary: string | null;
    updated_at: string;
  }[];
  household_members: {
    member_id: string; firm_id: string; advisor_id: string; household_id: string;
    full_name: string; role: string; email: string | null; date_of_birth: string | null;
  }[];
  accounts: {
    account_id: string; firm_id: string; advisor_id: string; household_id: string;
    custodian: string; account_number: string; account_type: string; status: string;
    cash_balance: number; market_value: number; ytd_return_pct: number; as_of_date: string;
  }[];
  positions: {
    position_id: string; firm_id: string; advisor_id: string; account_id: string;
    household_id: string; symbol: string; asset_class: string; quantity: number;
    market_price: number; market_value: number; cost_basis: number; as_of_date: string;
  }[];
  transactions: {
    transaction_id: string; firm_id: string; advisor_id: string; account_id: string;
    household_id: string; txn_type: string; symbol: string | null; quantity: number | null;
    amount: number; txn_date: string; description: string; custodian: string;
  }[];
  meeting_notes: {
    note_id: string; firm_id: string; advisor_id: string; household_id: string;
    meeting_date: string; title: string; attendees: string[]; transcript: string;
  }[];
  emails: {
    email_id: string; firm_id: string; advisor_id: string; household_id: string;
    sent_at: string; direction: string; sender: string; recipient: string;
    subject: string; body: string;
  }[];
  calendar_events: {
    event_id: string; firm_id: string; advisor_id: string; household_id: string;
    title: string; starts_at: string; ends_at: string; location: string | null;
    description: string | null;
  }[];
  tasks: {
    task_id: string; firm_id: string; advisor_id: string; household_id: string;
    title: string; status: string; priority: string; due_date: string | null;
    source_ref: string | null; created_at: string;
  }[];
}

export async function seedAdvisorBook(pool: Pool, book: AdvisorBookData): Promise<Record<string, number>> {
  for (const firm of book.firms) {
    await pool.query(
      `INSERT INTO firms (firm_id, name, is_synthetic)
       VALUES ($1, $2, $3)
       ON CONFLICT (firm_id) DO UPDATE SET name = EXCLUDED.name, is_synthetic = EXCLUDED.is_synthetic`,
      [firm.firm_id, firm.name, firm.is_synthetic],
    );
  }

  for (const adv of book.advisors) {
    await pool.query(
      `INSERT INTO advisors (advisor_id, firm_id, name, email, auth_subject)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (advisor_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, auth_subject = EXCLUDED.auth_subject`,
      [adv.advisor_id, adv.firm_id, adv.name, adv.email, adv.auth_subject],
    );
  }

  // Precompute embeddings for all meeting notes and emails once before transactions.
  const noteEmbeddings = await embedTexts(book.meeting_notes.map((n) => `${n.title}\n${n.transcript}`));
  const emailEmbeddings = await embedTexts(book.emails.map((e) => `${e.subject}\n${e.body}`));
  const noteVecById = new Map(book.meeting_notes.map((n, i) => [n.note_id, toPgVectorLiteral(noteEmbeddings[i]!)]));
  const emailVecById = new Map(book.emails.map((e, i) => [e.email_id, toPgVectorLiteral(emailEmbeddings[i]!)]));

  // Seed each advisor's rows strictly inside that advisor's RLS context.
  for (const adv of book.advisors) {
    await withTenantContext(pool, { firmId: adv.firm_id, advisorId: adv.advisor_id }, async (client) => {
      for (const hh of book.households.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO households (
             household_id, firm_id, advisor_id, name, primary_email, phone, address,
             risk_profile, target_equity_pct, target_fixed_income_pct, target_cash_pct,
             last_review_date, next_review_date, notes_summary, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (household_id) DO UPDATE SET
             name = EXCLUDED.name, primary_email = EXCLUDED.primary_email, phone = EXCLUDED.phone,
             address = EXCLUDED.address, risk_profile = EXCLUDED.risk_profile,
             target_equity_pct = EXCLUDED.target_equity_pct,
             target_fixed_income_pct = EXCLUDED.target_fixed_income_pct,
             target_cash_pct = EXCLUDED.target_cash_pct,
             last_review_date = EXCLUDED.last_review_date,
             next_review_date = EXCLUDED.next_review_date,
             notes_summary = EXCLUDED.notes_summary,
             updated_at = EXCLUDED.updated_at`,
          [
            hh.household_id, hh.firm_id, hh.advisor_id, hh.name, hh.primary_email, hh.phone, hh.address,
            hh.risk_profile, hh.target_equity_pct, hh.target_fixed_income_pct, hh.target_cash_pct,
            hh.last_review_date, hh.next_review_date, hh.notes_summary, hh.updated_at,
          ],
        );
      }

      for (const m of book.household_members.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO household_members (member_id, firm_id, advisor_id, household_id, full_name, role, email, date_of_birth)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (member_id) DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, email = EXCLUDED.email`,
          [m.member_id, m.firm_id, m.advisor_id, m.household_id, m.full_name, m.role, m.email, m.date_of_birth],
        );
      }

      for (const a of book.accounts.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO accounts (
             account_id, firm_id, advisor_id, household_id, custodian, account_number,
             account_type, status, cash_balance, market_value, ytd_return_pct, as_of_date
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (account_id) DO UPDATE SET
             cash_balance = EXCLUDED.cash_balance, market_value = EXCLUDED.market_value,
             ytd_return_pct = EXCLUDED.ytd_return_pct, as_of_date = EXCLUDED.as_of_date`,
          [
            a.account_id, a.firm_id, a.advisor_id, a.household_id, a.custodian, a.account_number,
            a.account_type, a.status, a.cash_balance, a.market_value, a.ytd_return_pct, a.as_of_date,
          ],
        );
      }

      for (const p of book.positions.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO positions (
             position_id, firm_id, advisor_id, account_id, household_id, symbol,
             asset_class, quantity, market_price, market_value, cost_basis, as_of_date
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (position_id) DO UPDATE SET
             quantity = EXCLUDED.quantity, market_price = EXCLUDED.market_price,
             market_value = EXCLUDED.market_value, cost_basis = EXCLUDED.cost_basis`,
          [
            p.position_id, p.firm_id, p.advisor_id, p.account_id, p.household_id, p.symbol,
            p.asset_class, p.quantity, p.market_price, p.market_value, p.cost_basis, p.as_of_date,
          ],
        );
      }

      for (const t of book.transactions.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO transactions (
             transaction_id, firm_id, advisor_id, account_id, household_id, txn_type,
             symbol, quantity, amount, txn_date, description, custodian
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            t.transaction_id, t.firm_id, t.advisor_id, t.account_id, t.household_id, t.txn_type,
            t.symbol, t.quantity, t.amount, t.txn_date, t.description, t.custodian,
          ],
        );
      }

      for (const n of book.meeting_notes.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO meeting_notes (note_id, firm_id, advisor_id, household_id, meeting_date, title, attendees, transcript, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)
           ON CONFLICT (note_id) DO UPDATE SET
             title = EXCLUDED.title, transcript = EXCLUDED.transcript, embedding = EXCLUDED.embedding`,
          [
            n.note_id, n.firm_id, n.advisor_id, n.household_id, n.meeting_date,
            n.title, n.attendees, n.transcript, noteVecById.get(n.note_id),
          ],
        );
      }

      for (const e of book.emails.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO emails (email_id, firm_id, advisor_id, household_id, sent_at, direction, sender, recipient, subject, body, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
           ON CONFLICT (email_id) DO UPDATE SET
             subject = EXCLUDED.subject, body = EXCLUDED.body, embedding = EXCLUDED.embedding`,
          [
            e.email_id, e.firm_id, e.advisor_id, e.household_id, e.sent_at,
            e.direction, e.sender, e.recipient, e.subject, e.body, emailVecById.get(e.email_id),
          ],
        );
      }

      for (const ev of book.calendar_events.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO calendar_events (event_id, firm_id, advisor_id, household_id, title, starts_at, ends_at, location, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (event_id) DO NOTHING`,
          [ev.event_id, ev.firm_id, ev.advisor_id, ev.household_id, ev.title, ev.starts_at, ev.ends_at, ev.location, ev.description],
        );
      }

      for (const task of book.tasks.filter((r) => r.advisor_id === adv.advisor_id)) {
        await client.query(
          `INSERT INTO tasks (task_id, firm_id, advisor_id, household_id, title, status, priority, due_date, source_ref, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (task_id) DO NOTHING`,
          [
            task.task_id, task.firm_id, task.advisor_id, task.household_id, task.title,
            task.status, task.priority, task.due_date, task.source_ref, task.created_at,
          ],
        );
      }
    });
  }

  return {
    households: book.households.length,
    accounts: book.accounts.length,
    positions: book.positions.length,
    transactions: book.transactions.length,
    meeting_notes: book.meeting_notes.length,
    emails: book.emails.length,
    calendar_events: book.calendar_events.length,
    tasks: book.tasks.length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const bookPath = resolve(process.argv[2] ?? "../.demo/advisor_book/book.json");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Set DATABASE_URL before running seed.ts");
    process.exit(1);
  }
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool);
    const book = JSON.parse(readFileSync(bookPath, "utf-8")) as AdvisorBookData;
    const counts = await seedAdvisorBook(pool, book);
    console.log(JSON.stringify({ migrations_applied: applied, seeded: counts }));
  } finally {
    await closePool(pool);
  }
}
