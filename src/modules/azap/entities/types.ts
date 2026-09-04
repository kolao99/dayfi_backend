export type AzapEntityKind = 'recipient' | 'biller';

export type AzapEntityAlias = {
  id: string;
  userId: string;
  kind: AzapEntityKind;
  alias: string;
  /** Dayfi beneficiary id, bill account id, etc. */
  targetId: string;
  displayLabel: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type EntityResolution =
  | { status: 'resolved'; alias: AzapEntityAlias }
  | { status: 'not_found'; alias: string; kind: AzapEntityKind }
  | {
      status: 'ambiguous';
      alias: string;
      kind: AzapEntityKind;
      matches: AzapEntityAlias[];
    };
