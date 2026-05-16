import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { contacts, legalEntities, organizations, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const DISTRIBUTION_TYPES = [
  "cash",
  "property",
  "guaranteed_payment",
  "tax_distribution",
  "liquidating",
] as const;

export const ownerDistributions = accSchema.table(
  "owner_distributions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    recipientContactId: uuid("recipient_contact_id")
      .notNull()
      .references(() => contacts.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    distributionDate: date("distribution_date").notNull(),
    distributionType: text("distribution_type").notNull(),
    linkedPaymentId: uuid("linked_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    linkedPeriod: text("linked_period"),
    equityAccountId: uuid("equity_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    approvalRequestId: uuid("approval_request_id").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    taxYear: integer("tax_year"),
    isTaxDistribution: boolean("is_tax_distribution").notNull().default(false),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("distributions_entity_date_idx").on(t.entityId, t.distributionDate),
    index("distributions_recipient_idx").on(
      t.recipientContactId,
      t.distributionDate,
    ),
    index("distributions_approval_idx").on(t.approvalRequestId),
    index("distributions_period_idx")
      .on(t.linkedPeriod)
      .where(sql`${t.linkedPeriod} IS NOT NULL`),
    check("distributions_amount_chk", sql`${t.amount} > 0`),
    check(
      "distributions_type_chk",
      sql`${t.distributionType} IN ('cash','property','guaranteed_payment','tax_distribution','liquidating')`,
    ),
  ],
);

export type OwnerDistribution = typeof ownerDistributions.$inferSelect;
export type NewOwnerDistribution = typeof ownerDistributions.$inferInsert;
