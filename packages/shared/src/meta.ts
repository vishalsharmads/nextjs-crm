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
  };
  customFields: (CustomFieldDef & { level: VisibilityLevel })[];
  fieldGroups: FieldGroupDto[];
  layouts: LayoutDto[];
  pipelines: PipelineDto[];
  modules: { enabled: string[]; menu: ModuleMenuItemDto[] };
}
