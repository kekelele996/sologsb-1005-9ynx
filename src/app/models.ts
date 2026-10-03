export type Role = 'author' | 'examiner' | 'viewer'

/** 案件特征与所内特征表的对应状态 */
export type LinkStatus = 'linked' | 'pending' | 'local'

/** 特征表暂存变更类型：改定义 / 拆分 / 停用 */
export type CatalogDraftKind = 'redefine' | 'split' | 'remove'

/** 案件最近一次与特征表对齐的结果 */
export type CaseSyncStatus = 'never' | 'ok' | 'has-pending' | 'failed'

export interface Claim {
  id: string
  number: number
  title: string
  text: string
  independent: boolean
}

export interface Paragraph {
  id: string
  section: string
  text: string
}

/** 所内统一维护的技术特征表条目，id 跨版本稳定 */
export interface CatalogFeature {
  id: string
  code: string
  label: string
  definition: string
  category: string
  status: 'active' | 'obsolete'
  version: number
  createdAt: string
  updatedAt: string
}

/** 挂起的引用：案件特征暂时对不上特征表，等代理人确认 */
export interface PendingLink {
  changeId: string
  fromCatalogId: string
  fromCatalogLabel: string
  candidateIds: string[]
  reason: string
  detectedAt: string
}

/** 案件工作区中的技术特征；引用特征表时存 catalogFeatureId，也可以是本案件自定义特征 */
export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  supportIds: string[]
  ownerRole: Role
  catalogFeatureId: string | null
  linkStatus: LinkStatus
  pending: PendingLink | null
  linkedCatalogVersion: number | null
}

export interface Annotation {
  id: string
  featureId: string
  authorRole: Role
  authorName: string
  text: string
  updatedAt: string
}

export interface OrphanMapping {
  id: string
  featureLabel: string
  paragraphId: string
  reason: string
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface Position {
  scrollY: number
}

/** 代理人各自的案件工作区 */
export interface CaseRecord {
  id: string
  name: string
  applicationNo: string
  agentName: string
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  selectedClaimId: string
  selectedFeatureId: string | null
  lastReconcileAt: string | null
  lastReconcileStatus: CaseSyncStatus
  lastReconcileError: string | null
}

export interface CatalogObsoleteEntry {
  featureId: string
  label: string
  kind: 'split' | 'remove'
  replacementIds: string[]
}

export interface CatalogModifiedEntry {
  featureId: string
  fromVersion: number
  toVersion: number
}

/** 一次特征表发布：拆分/停用进 obsolete，改定义进 modified */
export interface CatalogChange {
  id: string
  releasedAt: string
  releasedBy: Role
  note: string
  obsolete: CatalogObsoleteEntry[]
  modified: CatalogModifiedEntry[]
  addedFeatureIds: string[]
}

/** 发布前暂存的特征表变更 */
export interface CatalogDraft {
  id: string
  kind: CatalogDraftKind
  featureId: string
  targetLabel: string
  newLabel: string
  newDefinition: string
  newCategory: string
  splitParts?: Array<{ label: string; definition: string; category: string }>
  createdAt: string
}

export interface SyncAutoLink {
  featureId: string
  featureLabel: string
  fromCatalogId: string
  toCatalogId: string
  toLabel: string
  score: number
  via: 'replacement' | 'redefine'
}

export interface SyncSuspension {
  featureId: string
  featureLabel: string
  fromCatalogId: string
  candidateIds: string[]
  reason: string
}

export interface SyncReportEntry {
  caseId: string
  caseName: string
  status: 'success' | 'failed'
  ranAt: string
  changeIds: string[]
  autoLinked: SyncAutoLink[]
  suspended: SyncSuspension[]
  error: string | null
}

export interface WorkbenchState {
  version: 2
  catalog: CatalogFeature[]
  catalogChanges: CatalogChange[]
  catalogDrafts: CatalogDraft[]
  cases: CaseRecord[]
  activeCaseId: string
  activeTab: string
  role: Role
  currentUserRole: Role
  lastSyncReport: SyncReportEntry[]
  /** 故障演练：下一次发布同步时令该案件失败（一次性，重试时自动清除） */
  failNextCaseId: string | null
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'pending-link' | 'broken-catalog-link'
  featureId?: string
  title: string
  detail: string
}
