import { sql } from "drizzle-orm";
import { check, date, index, numeric, text, uuid } from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { organizations } from "../core";
import { journalEntries } from "./journal_entries";
import { loanAmortizationSchedule } from "./loan_amortization_schedule";
import { loans } from "./loans";
import { payments } from "./payments";

export const LOAN_PAYMENT_STATUSES = [
  "scheduled",
  "paid",
  "late",
  "partial",
  "missed",
  "reversed",
] as const;

export const loanPayments = accSchema.table(
  "loan_payments",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    scheduleEntryId: uuid("schedule_entry_id").references(
      () => loanAmortizationSchedule.id,
      { onDelete: "set null" },
    ),
    dueDate: date("due_date").notNull(),
    scheduledAmount: numeric("scheduled_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    principalPaid: numeric("principal_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    interestPaid: numeric("interest_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    escrowPaid: numeric("escrow_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    lateFeePaid: numeric("late_fee_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    principalExtra: numeric("principal_extra", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalPaid: numeric("total_paid", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`principal_paid + interest_paid + escrow_paid + late_fee_paid + principal_extra`,
    ),
    paidDate: date("paid_date"),
    paymentId: uuid("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("scheduled"),
    notes: text("notes"),
  },
  (t) => [
    index("loan_pmts_loan_due_idx").on(t.loanId, t.dueDate),
    index("loan_pmts_org_status_idx").on(t.orgId, t.status),
    index("loan_pmts_payment_idx")
      .on(t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL`),
    check(
      "loan_pmts_status_chk",
      sql`${t.status} IN ('scheduled','paid','late','partial','missed','reversed')`,
    ),
  ],
);

export type LoanPayment = typeof loanPayments.$inferSelect;
export type NewLoanPayment = typeof loanPayments.$inferInsert;
