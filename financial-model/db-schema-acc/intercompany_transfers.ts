import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  text,
  timestamp,
  numeric,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const INTERCOMPANY_TRANSFER_TYPES = [
  "distribution",
  "contribution",
  "management_fee",
  "reimbursement",
  "intercompany_loan",
  "loan_repayment",
  "expense_passthrough",
  "rent_passthrough",
  "property_transfer",
] as const;

export const INTERCOMPANY_STATUSES = [
  "pending",
  "approved",
  "completed",
  "reversed",
] as const;

export const intercompanyTransfers = accSchema.table(
  "intercompany_transfers",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    transferDate: date("transfer_date").notNull(),
    valueDate: date("value_date"),
    transferType: text("transfer_type").notNull(),
    linkedPaymentIds: uuid("linked_payment_ids").array(),
    linkedPeriod: text("linked_period"),
    fromPaymentId: uuid("from_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    toPaymentId: uuid("to_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    fromJournalEntryId: uuid("from_journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    toJournalEntryId: uuid("to_journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    fromAccountId: uuid("from_account_id").references(() => chartOfAccounts.id),
    toAccountId: uuid("to_account_id").references(() => chartOfAccounts.id),
    status: text("status").notNull().default("pending"),
    approvalRequestId: uuid("approval_request_id"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    memo: text("memo"),
    notes: text("notes"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("intercompany_org_status_idx").on(t.orgId, t.status),
    index("intercompany_from_idx").on(t.fromEntityId, t.transferDate),
    index("intercompany_to_idx").on(t.toEntityId, t.transferDate),
    index("intercompany_period_idx")
      .on(t.linkedPeriod)
      .where(sql`${t.linkedPeriod} IS NOT NULL`),
    index("intercompany_payments_idx").using("gin", t.linkedPaymentIds),
    check("intercompany_amount_chk", sql`${t.amount} > 0`),
    check(
      "intercompany_distinct_chk",
      sql`${t.fromEntityId} != ${t.toEntityId}`,
    ),
    check(
      "intercompany_type_chk",
      sql`${t.transferType} IN ('distribution','contribution','management_fee','reimbursement','intercompany_loan','loan_repayment','expense_passthrough','rent_passthrough','property_transfer')`,
    ),
    check(
      "intercompany_status_chk",
      sql`${t.status} IN ('pending','approved','completed','reversed')`,
    ),
  ],
);

export type IntercompanyTransfer = typeof intercompanyTransfers.$inferSelect;
export type NewIntercompanyTransfer = typeof intercompanyTransfers.$inferInsert;
