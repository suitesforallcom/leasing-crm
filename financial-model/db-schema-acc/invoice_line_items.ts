import { sql } from "drizzle-orm";
import {
  check,
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
import { legalEntities } from "../core";
import { properties, recurringCharges, rentConcessions } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";
import { invoices } from "./invoices";

export const INVOICE_LINE_CATEGORIES = [
  "rent",
  "late_fee",
  "utility",
  "deposit",
  "repair",
  "admin_fee",
  "cam",
  "tax_recovery",
  "insurance_recovery",
  "concession",
  "adjustment",
  "other",
] as const;

export const invoiceLineItems = accSchema.table(
  "invoice_line_items",
  {
    id: idCol(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 3 }),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    category: text("category"),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    propertyId: uuid("property_id").references(() => properties.id),
    recurringChargeId: uuid("recurring_charge_id").references(
      () => recurringCharges.id,
      { onDelete: "set null" },
    ),
    concessionId: uuid("concession_id").references(() => rentConcessions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("invoice_lines_uniq").on(t.invoiceId, t.lineNumber),
    index("invoice_lines_account_idx").on(t.accountId),
    index("invoice_lines_class_idx")
      .on(t.classId)
      .where(sql`${t.classId} IS NOT NULL`),
    index("invoice_lines_concession_idx")
      .on(t.concessionId)
      .where(sql`${t.concessionId} IS NOT NULL`),
    index("invoice_lines_recurring_idx")
      .on(t.recurringChargeId)
      .where(sql`${t.recurringChargeId} IS NOT NULL`),
    check(
      "invoice_lines_category_chk",
      sql`${t.category} IS NULL OR ${t.category} IN ('rent','late_fee','utility','deposit','repair','admin_fee','cam','tax_recovery','insurance_recovery','concession','adjustment','other')`,
    ),
  ],
);

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
