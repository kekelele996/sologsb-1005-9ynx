import type {
  AutoSwitchEntry, CaseFile, Feature, FeatureTable, MasterFeature,
  PendingCandidate, PendingLink, SyncStatus
} from './models'

/** 唯一自动换：最高分需达到该阈值且领先第二名足够多 */
const AUTO_UNIQUE_SCORE = 0.5
const AUTO_MARGIN = 0.18
/** 升级旧数据时把本地特征挂到特征表条目的阈值 */
const MIGRATE_SCORE = 0.34
const MIGRATE_MARGIN = 0.15

function normalize(text: string): string {
  return (text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

function ngrams(text: string, n: number): Set<string> {
  const value = normalize(text)
  const grams = new Set<string>()
  for (let i = 0; i + n <= value.length; i++) grams.add(value.slice(i, i + n))
  return grams
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  // 杰卡德相似度：避免极短定义只靠一两个共有字得到满分
  return shared / (a.size + b.size - shared)
}

/** 案件特征正文 与 特征表定义 的匹配度 0~1（二元组重叠为主，单字兜底） */
export function scoreMatch(featureText: string, definition: string): number {
  const biA = ngrams(featureText, 2)
  const biB = ngrams(definition, 2)
  const bi = overlap(biA, biB)
  const uni = overlap(ngrams(featureText, 1), ngrams(definition, 1))
  const score = bi * 0.8 + uni * 0.2
  return Math.round(score * 100) / 100
}

export function scoreCandidates(featureText: string, masters: MasterFeature[]): PendingCandidate[] {
  return masters
    .map(master => ({ tableFeatureId: master.id, label: master.label, definition: master.definition, score: scoreMatch(featureText, master.definition) }))
    .sort((a, b) => b.score - a.score)
}

function uniqueWinner(candidates: PendingCandidate[]): PendingCandidate | null {
  if (!candidates.length) return null
  const [best, second] = candidates
  if (best.score >= AUTO_UNIQUE_SCORE && best.score - (second?.score ?? 0) >= AUTO_MARGIN) return best
  return null
}

export interface CaseSyncPlan {
  /** 参与本次评估的案件特征（引用已退役/丢失条目者） */
  evaluatedFeatureIds: string[]
  auto: AutoSwitchEntry[]
  pending: PendingLink[]
}

function staleFeature(feature: Feature, table: FeatureTable): MasterFeature | null {
  if (!feature.tableFeatureId) return null
  const master = table.features.find(item => item.id === feature.tableFeatureId)
  if (!master) return { id: feature.tableFeatureId, code: '?', label: '（已缺失条目）', definition: '', status: 'retired', revision: 0, splitFromId: null, supersedesId: null, replacedByIds: [], updatedAt: '' }
  return master.status === 'retired' ? master : null
}

export function caseStaleFeatures(caseFile: CaseFile, table: FeatureTable): Feature[] {
  return caseFile.features.filter(feature => staleFeature(feature, table))
}

export function caseNeedsSync(caseFile: CaseFile, table: FeatureTable): boolean {
  return caseFile.pendingLinks.length > 0 || caseStaleFeatures(caseFile, table).length > 0 || caseFile.sync.status === 'failed'
}

function pendingId(featureId: string, tableFeatureId: string): string {
  return `pend-${featureId}-${tableFeatureId}`
}

/** 为单个案件构造对齐方案：纯函数，不改动案件数据 */
export function buildPlan(caseFile: CaseFile, table: FeatureTable, at: string): CaseSyncPlan {
  const plan: CaseSyncPlan = { evaluatedFeatureIds: [], auto: [], pending: [] }
  const previous = new Map(caseFile.pendingLinks.map(link => [link.id, link]))

  for (const feature of caseFile.features) {
    const master = staleFeature(feature, table)
    if (!master) continue
    plan.evaluatedFeatureIds.push(feature.id)

    const replacements = master.replacedByIds
      .map(id => table.features.find(item => item.id === id))
      .filter((item): item is MasterFeature => !!item && item.status === 'active')

    const makePending = (kind: 'split' | 'redefine', reason: string, candidates: PendingCandidate[]): PendingLink => {
      const id = pendingId(feature.id, master.id)
      const old = previous.get(id)
      return {
        id, featureId: feature.id, featureLabel: feature.label,
        tableFeatureId: master.id, tableFeatureLabel: master.label,
        kind, reason, candidates,
        detectedRevision: table.revision,
        detectedAt: old?.detectedAt || at
      }
    }

    if (!replacements.length) {
      plan.pending.push(makePending(
        'redefine',
        `特征表条目“${master.label}”已退役且没有替代条目，请把该特征改挂到其他条目，或脱离特征表保留为案件本地特征。`,
        []
      ))
      continue
    }

    const candidates = scoreCandidates(feature.text, replacements)

    if (replacements.length === 1) {
      const only = replacements[0]
      plan.auto.push({
        featureId: feature.id, featureLabel: feature.label,
        fromTableId: master.id, fromTableLabel: master.label,
        toTableId: only.id, toTableLabel: only.label,
        reason: only.supersedesId === master.id ? 'redefine' : 'split',
        score: candidates[0]?.score ?? 0, at
      })
      continue
    }

    const winner = uniqueWinner(candidates)
    if (winner) {
      plan.auto.push({
        featureId: feature.id, featureLabel: feature.label,
        fromTableId: master.id, fromTableLabel: master.label,
        toTableId: winner.tableFeatureId, toTableLabel: winner.label,
        reason: 'split', score: winner.score, at
      })
    } else {
      const names = replacements.map(item => `“${item.label}”`).join('、')
      plan.pending.push(makePending(
        'split',
        `特征表已把“${master.label}”拆分为 ${replacements.length} 条：${names}。按案件特征正文无法唯一对应，请代理人确认。`,
        candidates
      ))
    }
  }
  return plan
}

/** 在案件克隆上应用方案；返回同一引用，便于调用方一次性替换 */
export function applyPlan(caseFile: CaseFile, plan: CaseSyncPlan, revision: number, at: string): CaseFile {
  const evaluated = new Set(plan.evaluatedFeatureIds)

  for (const entry of plan.auto) {
    const feature = caseFile.features.find(item => item.id === entry.featureId)
    if (!feature) continue
    feature.tableFeatureId = entry.toTableId
    feature.alignedRevision = revision
  }
  caseFile.sync.autoSwitchLog = [...plan.auto, ...caseFile.sync.autoSwitchLog].slice(0, 40)

  // 重算挂起：未参与本次评估的旧挂起保留，新结果替换同特征的旧挂起
  const kept = caseFile.pendingLinks.filter(link => !evaluated.has(link.featureId))
  caseFile.pendingLinks = [...plan.pending, ...kept]

  const hasPending = caseFile.pendingLinks.length > 0
  const status: SyncStatus = hasPending ? 'out-of-sync' : 'synced'
  caseFile.sync.status = status
  caseFile.sync.alignedRevision = hasPending ? caseFile.sync.alignedRevision : revision
  caseFile.sync.lastRunAt = at
  caseFile.sync.lastError = null
  caseFile.sync.attemptedRevision = null
  return caseFile
}

/** 代理人手动确认一条挂起：改挂指定条目，或脱离特征表 */
export function resolvePendingLink(
  caseFile: CaseFile, linkId: string,
  choice: { type: 'pick'; tableFeatureId: string } | { type: 'detach' },
  table: FeatureTable, at: string
): CaseSyncPlan | null {
  const link = caseFile.pendingLinks.find(item => item.id === linkId)
  const feature = link && caseFile.features.find(item => item.id === link.featureId)
  if (!link || !feature) return null

  if (choice.type === 'detach') {
    feature.tableFeatureId = null
    feature.alignedRevision = null
  } else {
    const target = table.features.find(item => item.id === choice.tableFeatureId && item.status === 'active')
    if (!target) return null
    feature.tableFeatureId = target.id
    feature.alignedRevision = table.revision
  }
  caseFile.pendingLinks = caseFile.pendingLinks.filter(item => item.id !== linkId)

  const stillStale = caseStaleFeatures(caseFile, table).length > 0 || caseFile.pendingLinks.length > 0
  caseFile.sync.status = stillStale ? 'out-of-sync' : 'synced'
  if (!stillStale) caseFile.sync.alignedRevision = table.revision
  caseFile.sync.lastRunAt = at
  return null
}

/** 把旧版（v1：单案件平铺、特征不引用特征表）数据升级为引用特征表的结构 */
export function migrateLegacyState(
  raw: Record<string, unknown>,
  currentTable: FeatureTable,
  referenceTable: FeatureTable,
  at: string
): CaseFile {
  const features = (Array.isArray(raw['features']) ? raw['features'] : []) as Feature[]
  const activeMasters = referenceTable.features.filter(item => item.status === 'active')
  const linked = features.map(feature => {
    const candidates = scoreCandidates(feature.text, activeMasters)
    const best = candidates[0]
    const ok = best && best.score >= MIGRATE_SCORE && best.score - (candidates[1]?.score ?? 0) >= MIGRATE_MARGIN
    return {
      feature: { ...feature, tableFeatureId: ok ? best.tableFeatureId : null, alignedRevision: ok ? referenceTable.revision : null },
      linked: !!ok
    }
  })

  const caseFile: CaseFile = {
    id: 'case-migrated',
    name: '本机已存案件（由旧版工作台升级）',
    agent: '本机代理人',
    claims: (Array.isArray(raw['claims']) ? raw['claims'] : []) as CaseFile['claims'],
    paragraphs: (Array.isArray(raw['paragraphs']) ? raw['paragraphs'] : []) as CaseFile['paragraphs'],
    features: linked.map(item => item.feature),
    annotations: (Array.isArray(raw['annotations']) ? raw['annotations'] : []) as CaseFile['annotations'],
    orphanMappings: (Array.isArray(raw['orphanMappings']) ? raw['orphanMappings'] : []) as CaseFile['orphanMappings'],
    versions: (Array.isArray(raw['versions']) ? raw['versions'] : []) as CaseFile['versions'],
    pendingLinks: [],
    sync: {
      status: 'synced',
      alignedRevision: referenceTable.revision,
      lastRunAt: at,
      lastError: null,
      attemptedRevision: null,
      autoSwitchLog: []
    },
    selectedClaimId: String(raw['selectedClaimId'] ?? ''),
    selectedFeatureId: (raw['selectedFeatureId'] as string | null) ?? null
  }

  // 挂到特征表旧版本条目的引用，按当前特征表再走一遍“唯一自动换 / 挂起”；
  // 对不上的保留为案件本地特征，说明书依据不悬空。
  const plan = buildPlan(caseFile, currentTable, at)
  applyPlan(caseFile, plan, currentTable.revision, at)
  return caseFile
}
