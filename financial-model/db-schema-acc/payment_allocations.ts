import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { legalEntities, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { creditMemos } from "./credit_memos";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const ALLOCATION_TARGET_TYPES = [
  "invoice_line_item",
  "loan_payment",
  "security_deposit",
  "customer_credit",
  "prepayment",
  "writeoff",
  "credit_memo",
  "intercompany",
  "other",
] as const;

export const paymentAllocations = accSchema.table(
  "payment_allocations",
  {
    id: idCol(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    allocatedToType: text("allocated_to_type").notNull(),
    allocatedToId: uuid("allocated_to_id"),
    invoiceId: uuid("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    creditMemoId: uuid("credit_memo_id").references(() => creditMemos.id, {
      onDelete: "set null",
    }),
    loanPaymentId: uuid("loan_payment_id"),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    allocationDate: date("allocation_date").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    entityId: uuid("entity_id").references(() => legalEntities.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    index("pmt_alloc_payment_idx").on(t.paymentId),
    index("pmt_alloc_invoice_idx")
      .on(t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    index("pmt_alloc_target_idx").on(t.allocatedToType, t.allocatedToId),
    index("pmt_alloc_credit_idx")
      .on(t.creditMemoId)
      .where(sql`${t.creditMemoId} IS NOT NULL`),
    index("pmt_alloc_loan_pmt_idx")
      .on(t.loanPaymentId)
      .where(sql`${t.loanPaymentId} IS NOT NULL`),
    check("pmt_alloc_amount_chk", sql`${t.amount} > 0`),
    check(
      "pmt_alloc_target_type_chk",
      sql`${t.allocatedToType} IN ('invoice_line_item','loan_payment','security_deposit','customer_credit','prepayment','writeoff','credit_memo','intercompany','other')`,
    ),
  ],
);

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type NewPaymentAllocation = typeof paymentAllocations.$inferInsert;
