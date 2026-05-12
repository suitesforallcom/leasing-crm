import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { chartOfAccounts } from "./chart_of_accounts";
import { creditMemos } from "./credit_memos";
import { invoiceLineItems } from "./invoice_line_items";

export const creditMemoLineItems = accSchema.table(
  "credit_memo_line_items",
  {
    id: idCol(),
    creditMemoId: uuid("credit_memo_id")
      .notNull()
      .references(() => creditMemos.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    originalInvoiceLineItemId: uuid("original_invoice_line_item_id").references(
      () => invoiceLineItems.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("cm_lines_uniq").on(t.creditMemoId, t.lineNumber),
    index("cm_lines_orig_idx")
      .on(t.originalInvoiceLineItemId)
      .where(sql`${t.originalInvoiceLineItemId} IS NOT NULL`),
  ],
);

export type CreditMemoLineItem = typeof creditMemoLineItems.$inferSelect;
export type NewCreditMemoLineItem = typeof creditMemoLineItems.$inferInsert;
