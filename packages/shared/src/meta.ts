import type { AccessDto, MeDto } from './auth';
import type { CustomFieldDef, VisibilityLevel } from './custom-fields';
import type {
  CommerceSettings,
  ContactSettings,
  DealSettings,
  FeatureSettings,
  GeneralSettings,
} from './settings';
import type { ComplianceProfile } from './compliance';

export interface StageDto {
  uuid: string;
  key: string;
  name: string;
  color: string | null;
  probability: number;
  sortOrder: number;
  isWon: boolean;
  isLost: boolean;
  rottingDays: number | null;
}

export interface PipelineDto {
  uuid: string;
  name: string;
  entity: 'deal' | 'lead' | 'ticket';
  isDefault: boolean;
  sortOrder: number;
  stages: StageDto[];
  sourceBlueprint: string | null;
  customized: boolean;
}

export interface LayoutSection {
  key: string;
  label: string;
  fields: string[];
}

export interface LayoutDto {
  entity: string;
  context: 'form' | 'detail' | 'list';
  sections?: LayoutSection[];
  columns?: string[];
}

export interface FieldGroupDto {
  entity: string;
  key: string;
  label: string;
  sortOrder: number;
}

export interface ModuleMenuItemDto {
  moduleKey: string;
  key: string;
  label: string;
  path: string;
  icon: string;
  permission: string;
  order: number;
}

/** A tab a module adds to a record page. */
export interface RecordPanelDto {
  moduleKey: string;
  key: string;
  entity: string;
  title: string;
  order: number;
}

/** Core column of a module record type, enough for the web to render lists, forms and filters. */
export interface RecordColumnMeta {
  key: string;
  label: string;
  kind: RecordColumnKind;
  required: boolean;
  sortable: boolean;
  filterable: boolean;
  /** Select choices. */
  options?: { value: string; label: string }[];
  /** Record type a relation column points at: a core entity, or an admin-defined object. */
  relation?: string;
  /** ISO currency for money columns. */
  currency?: string;
}

export const RECORD_COLUMN_KINDS = [
  'text',
  'textarea',
  'email',
  'phone',
  'url',
  'number',
  'money',
  'date',
  'datetime',
  'boolean',
  'select',
  'user',
  'relation',
] as const;
export type RecordColumnKind = (typeof RECORD_COLUMN_KINDS)[number];

/** A record type a module registers; core entities keep their hand-written web config. */
export interface RecordTypeMeta {
  entity: string;
  moduleKey: string;
  /** URL segment under `/m/<moduleKey>/`. */
  route: string;
  /** Permission resource, e.g. `properties.properties`. */
  resource: string;
  titleColumn: string;
  columns: RecordColumnMeta[];
  defaultColumns: string[];
  defaultSort: string;
  searchable: boolean;
}

export interface BootstrapDto {
  me: MeDto;
  access: AccessDto;
  labels: Record<string, { singular: string; plural: string }>;
  settings: {
    general: GeneralSettings;
    features: FeatureSettings;
    deals: DealSettings;
    contacts: ContactSettings;
    commerce: CommerceSettings;
    /** Effective session limits (after the compliance profile's floors), for the client idle timer. */
    session: { idleTimeoutMinutes: number; profile: ComplianceProfile };
    /** Active consent purposes (for form editors and record pages). */
    consentPurposes: { key: string; label: string; marketing: boolean }[];
  };
  customFields: (CustomFieldDef & { level: VisibilityLevel })[];
  fieldGroups: FieldGroupDto[];
  layouts: LayoutDto[];
  pipelines: PipelineDto[];
  modules: {
    enabled: string[];
    menu: ModuleMenuItemDto[];
    panels: RecordPanelDto[];
    shellPanels: { moduleKey: string; key: string; title: string; icon: string }[];
  };
  /** Record types of enabled modules the user can view. */
  recordTypes: RecordTypeMeta[];
  /** Industry notes for help articles, by article id (from the blueprint). */
  helpNotes: Record<string, string>;
}
