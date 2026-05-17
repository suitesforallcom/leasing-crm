import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { leases, recurringCharges } from "../pm";
import { journalEntries } from "./journal_entries";

export const INVOICE_TYPES = [
  "invoice",
  "proforma",
  "credit_memo",
  "recurring_template",
] as const;

export const INVOICE_COUNTERPARTY_TYPES = [
  "tenant",
  "vendor",
  "other",
] as const;

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "partial",
  "paid",
  "overdue",
  "void",
  "written_off",
] as const;

export const invoices = accSchema.table(
  "invoices",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceType: text("invoice_type").notNull().default("invoice"),
    issuingEntityId: uuid("issuing_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    beneficiaryEntityId: uuid("beneficiary_entity_id").references(
      () => legalEntities.id,
    ),
    counterpartyType: text("counterparty_type").notNull(),
    counterpartyContactId: uuid("counterparty_contact_id")
      .notNull()
      .references(() => contacts.id),
    leaseId: uuid("lease_id").references(() => leases.id, {
      onDelete: "set null",
    }),
    recurringChargeId: uuid("recurring_charge_id").references(
      () => recurringCharges.id,
      { onDelete: "set null" },
    ),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    servicePeriodStart: date("service_period_start"),
    servicePeriodEnd: date("service_period_end"),
    subtotal: numeric("subtotal", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(sql`subtotal + tax_amount`),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountCredited: numeric("amount_credited", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountWrittenOff: numeric("amount_written_off", {
      precision: 15,
      scale: 2,
    })
      .notNull()
      .default("0"),
    balanceDue: numeric("balance_due", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`subtotal + tax_amount - amount_paid - amount_credited - amount_written_off`,
    ),
    status: text("status").notNull().default("draft"),
    terms: text("terms"),
    memo: text("memo"),
    internalNotes: text("internal_notes"),
    currency: text("currency").notNull().default("USD"),
    stripeInvoiceId: text("stripe_invoice_id"),
    xeroInvoiceId: text("xero_invoice_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    pdfDocumentId: uuid("pdf_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    lastReminderSentAt: timestamp("last_reminder_sent_at", {
      withTimezone: true,
    }),
    reminderCount: integer("reminder_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    voidedBy: uuid("voided_by").references(() => users.id),
    payLinkToken: text("pay_link_token"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
  },
  (t) => [
    uniqueIndex("invoices_number_uniq").on(t.orgId, t.invoiceNumber),
    index("invoices_status_due_idx").on(t.orgId, t.status, t.dueDate),
    uniqueIndex("invoices_pay_link_token_uniq")
      .on(t.payLinkToken)
      .where(sql`${t.payLinkToken} IS NOT NULL`),
    uniqueIndex("invoices_stripe_pi_uniq")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    index("invoices_counterparty_idx").on(t.counterpartyContactId, t.status),
    index("invoices_lease_idx")
      .on(t.leaseId)
      .where(sql`${t.leaseId} IS NOT NULL`),
    index("invoices_recurring_idx")
      .on(t.recurringChargeId)
      .where(sql`${t.recurringChargeId} IS NOT NULL`),
    index("invoices_entity_idx").on(t.issuingEntityId, t.status, t.issueDate),
    uniqueIndex("invoices_stripe_uniq")
      .on(t.stripeInvoiceId)
      .where(sql`${t.stripeInvoiceId} IS NOT NULL`),
    uniqueIndex("invoices_xero_uniq")
      .on(t.xeroInvoiceId)
      .where(sql`${t.xeroInvoiceId} IS NOT NULL`),
    check(
      "invoices_type_chk",
      sql`${t.invoiceType} IN ('invoice','proforma','credit_memo','recurring_template')`,
    ),
    check(
      "invoices_counterparty_type_chk",
      sql`${t.counterpartyType} IN ('tenant','vendor','other')`,
    ),
    check(
      "invoices_status_chk",
      sql`${t.status} IN ('draft','sent','viewed','partial','paid','overdue','void','written_off')`,
    ),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
