export type Role = 'author' | 'examiner' | 'viewer'

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

/** 所级技术特征表里的一条特征定义 */
export interface MasterFeature {
  id: string
  code: string
  label: string
  /** 特征表中维护的标准定义（案件按此重新对上） */
  definition: string
  status: 'active' | 'retired'
  /** 该条目最近一次生效所对应的特征表版本 */
  revision: number
  /** 拆分来源：本条目由哪个旧条目拆出 */
  splitFromId: string | null
  /** 重定义来源：本条目替代了哪个旧条目 */
  supersedesId: string | null
  /** 旧条目退役时指向的新生效条目（一条为重定义，多条为拆分） */
  replacedByIds: string[]
  updatedAt: string
}

export interface FeatureTable {
  revision: number
  features: MasterFeature[]
}

export interface Feature {
  id: string
  claimId: string
  label: string
  text: string
  parentId: string | null
  referenceIds: string[]
  supportIds: string[]
  ownerRole: Role
  /** 引用的所级特征表条目；null 表示案件本地特征（未挂特征表或已脱离） */
  tableFeatureId: string | null
  /** 最近一次对上特征表时的表版本 */
  alignedRevision: number | null
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

export interface PendingCandidate {
  tableFeatureId: string
  label: string
  definition: string
  /** 与案件本地特征正文的相似度 0~1，供代理人判断 */
  score: number
}

/** 特征表变更后无法唯一对上、挂起等待代理人确认的引用 */
export interface PendingLink {
  id: string
  /** 案件本地特征 id（特征被删除时挂起记录一并清理，不允许悬空） */
  featureId: string
  featureLabel: string
  /** 变更前指向的、现已退役的特征表条目 id */
  tableFeatureId: string
  tableFeatureLabel: string
  kind: 'split' | 'redefine'
  reason: string
  candidates: PendingCandidate[]
  detectedRevision: number
  detectedAt: string
}

export interface AutoSwitchEntry {
  featureId: string
  featureLabel: string
  fromTableId: string
  fromTableLabel: string
  toTableId: string
  toTableLabel: string
  reason: 'split' | 'redefine'
  score: number
  at: string
}

export type SyncStatus = 'synced' | 'out-of-sync' | 'failed'

export interface CaseSyncState {
  status: SyncStatus
  /** 案件已对上的特征表版本 */
  alignedRevision: number
  lastRunAt: string | null
  lastError: string | null
  /** 最近一次同步尝试处理的表版本（含失败的尝试） */
  attemptedRevision: number | null
  autoSwitchLog: AutoSwitchEntry[]
}

export interface ClaimVersion {
  id: string
  name: string
  createdAt: string
  claims: Claim[]
  features: Feature[]
}

export interface CaseFile {
  id: string
  name: string
  agent: string
  claims: Claim[]
  paragraphs: Paragraph[]
  features: Feature[]
  annotations: Annotation[]
  orphanMappings: OrphanMapping[]
  versions: ClaimVersion[]
  pendingLinks: PendingLink[]
  sync: CaseSyncState
  selectedClaimId: string
  selectedFeatureId: string | null
}

export interface Position {
  activeCaseId: string
  view: 'case' | 'table'
  tab: string
  scrollY: number
}

export interface WorkbenchState {
  schemaVersion: 2
  table: FeatureTable
  cases: CaseFile[]
  activeCaseId: string
  view: 'case' | 'table'
  activeTab: string
  role: Role
  currentUserRole: Role
  /** 演练用：标记某案件下一次同步注入失败，演示按案件回退与重试 */
  failNextSyncCaseIds: string[]
}

export interface ValidationIssue {
  id: string
  severity: 'error' | 'warning'
  type: 'cycle' | 'missing-support' | 'orphan-mapping' | 'empty-feature' | 'pending-link'
  featureId?: string
  title: string
  detail: string
}
