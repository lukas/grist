export type SkillInstallScope = "global" | "project";
export type SkillScope = SkillInstallScope | "bundled";
export type SkillSourceKind = "bundled" | "local" | "url";

export interface SkillFrontmatter {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SkillInstallSource {
  kind: SkillSourceKind;
  value: string;
}

export interface SkillInstallMetadata {
  installedAt: string;
  scope: SkillInstallScope;
  source: SkillInstallSource;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  dirPath: string;
  skillPath: string;
  references: string[];
  body: string;
  frontmatter: SkillFrontmatter;
  installMetadata?: SkillInstallMetadata;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSourceKind;
  sourceValue: string;
  installedScopes: SkillInstallScope[];
}

export interface SkillCatalogView {
  available: SkillCatalogEntry[];
  installedGlobal: SkillSummary[];
  installedProject: SkillSummary[];
}
