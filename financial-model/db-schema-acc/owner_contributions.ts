import { sql } from "drizzle-orm";
import { check, date, index, numeric, text, uuid } from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { properties } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const CONTRIBUTION_TYPES = [
  "cash",
  "property",
  "services",
  "assumption_of_debt",
  "equipment",
] as const;

export const ownerContributions = accSchema.table(
  "owner_contributions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    contributorContactId: uuid("contributor_contact_id")
      .notNull()
      .references(() => contacts.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    contributionDate: date("contribution_date").notNull(),
    contributionType: text("contribution_type").notNull(),
    linkedPaymentId: uuid("linked_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    linkedPropertyId: uuid("linked_property_id").references(
      () => properties.id,
      { onDelete: "set null" },
    ),
    equityAccountId: uuid("equity_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    documentationDocumentId: uuid("documentation_document_id").references(
      () => documents.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("contributions_entity_date_idx").on(t.entityId, t.contributionDate),
    index("contributions_contributor_idx").on(t.contributorContactId),
    check("contributions_amount_chk", sql`${t.amount} > 0`),
    check(
      "contributions_type_chk",
      sql`${t.contributionType} IN ('cash','property','services','assumption_of_debt','equipment')`,
    ),
  ],
);

export type OwnerContribution = typeof ownerContributions.$inferSelect;
export type NewOwnerContribution = typeof ownerContributions.$inferInsert;
