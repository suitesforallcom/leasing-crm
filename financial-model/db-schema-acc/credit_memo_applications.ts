import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { users } from "../core";
import { creditMemos } from "./credit_memos";
import { invoiceLineItems } from "./invoice_line_items";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";

export const creditMemoApplications = accSchema.table(
  "credit_memo_applications",
  {
    id: idCol(),
    creditMemoId: uuid("credit_memo_id")
      .notNull()
      .references(() => creditMemos.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    invoiceLineItemId: uuid("invoice_line_item_id").references(
      () => invoiceLineItems.id,
      { onDelete: "set null" },
    ),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    applicationDate: date("application_date").notNull(),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    appliedBy: uuid("applied_by")
      .notNull()
      .references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    index("cm_apps_credit_idx").on(t.creditMemoId),
    index("cm_apps_invoice_idx").on(t.invoiceId),
    uniqueIndex("cm_apps_unique").on(
      t.creditMemoId,
      t.invoiceId,
      t.invoiceLineItemId,
    ),
    check("cm_apps_amount_chk", sql`${t.amount} > 0`),
  ],
);

export type CreditMemoApplication = typeof creditMemoApplications.$inferSelect;
export type NewCreditMemoApplication =
  typeof creditMemoApplications.$inferInsert;
