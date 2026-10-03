import type {
  CatalogChange,
  CatalogFeature,
  Feature,
  PendingLink,
  SyncAutoLink,
  SyncSuspension
} from './models'

/**
 * 特征表 → 案件引用的对应引擎（纯函数，便于单测与“失败回滚”语义）。
 *
 * 规则：
 * - 特征表条目被停用（拆分/移除）或改定义后，引用旧条目的案件特征重新对一遍。
 * - 候选唯一且相似度达标：自动换引用（autoLinked）。
 * - 候选为空、或最高分不达标、或前两名分差过小：挂起（suspended），保留原引用与说明书依据，等代理人确认。
 * - 重试只处理仍挂起/引用失效的特征；已经对上的不再重复动。
 */

/** 唯一自动换引用的最低相似度（Sørensen–Dice bigram） */
export const AUTO_LINK_THRESHOLD = 0.32
/** 前两名候选的分差小于该值时视为“不唯一”，挂起等确认 */
export const AMBIGUITY_MARGIN = 0.08

export interface ReconcileInput {
  caseId: string
  features: Feature[]
  catalog: CatalogFeature[]
  changes: CatalogChange[]
  /** 本次只处理这些变更；为空时按特征表现状做全量核对 */
  changeIds?: string[]
  detectedAt: string
  /** 故障演练钩子：命中时抛错，调用方负责整案回滚 */
  fault?: Error | null
}

export interface ReconcileResult {
  features: Feature[]
  autoLinked: SyncAutoLink[]
  suspended: SyncSuspension[]
}

/** 归一化：去掉标点/空白/常见权利要求连接词，统一小写 */
export function normalizeText(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[，。、；：？！“”‘’"'（）()\[\]【】\s,.;:?!·—\-\/]/g, '')
    .replace(/所述|一种|以及|并且|用于|设置于|根据|其特征在于|本发明|上述/g, '')
}

function bigrams(text: string): string[] {
  const grams: string[] = []
  for (let i = 0; i < text.length - 1; i++) grams.push(text.slice(i, i + 2))
  return grams
}

/** Sørensen–Dice 系数，纯中文短句上比字符集合更稳 */
export function similarity(a: string, b: string): number {
  const left = bigrams(normalizeText(a))
  const right = bigrams(normalizeText(b))
  if (!left.length || !right.length) {
    const la = normalizeText(a)
    const rb = normalizeText(b)
    if (la && rb) return la === rb ? 1 : 0
    return 0
  }
  const rightCounts = new Map<string, number>()
  right.forEach(gram => rightCounts.set(gram, (rightCounts.get(gram) || 0) + 1))
  let overlap = 0
  const used = new Map<string, number>()
  left.forEach(gram => {
    const hit = used.get(gram) || 0
    const total = rightCounts.get(gram) || 0
    if (hit < total) { overlap++; used.set(gram, hit + 1) }
  })
  return (2 * overlap) / (left.length + right.length)
}

interface ObsoleteMapEntry {
  label: string
  kind: 'split' | 'remove'
  replacementIds: string[]
}

export function scoreCandidate(feature: Feature, candidate: CatalogFeature): number {
  const textScore = similarity(feature.text, candidate.definition)
  const labelScore = similarity(`${feature.label} ${feature.text}`, `${candidate.label} ${candidate.definition}`)
  // 正文定义是主要依据，标签做辅助
  return Math.max(textScore, labelScore * 0.85)
}

/** 在候选特征表条目中挑唯一对应；不唯一时返回 null */
export function findUniqueMatch(
  feature: Feature,
  candidates: CatalogFeature[]
): { candidate: CatalogFeature; score: number } | null {
  if (!candidates.length) return null
  const scored = candidates
    .map(candidate => ({ candidate, score: scoreCandidate(feature, candidate) }))
    .sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (top.score < AUTO_LINK_THRESHOLD) return null
  const second = scored[1]
  if (second && top.score - second.score < AMBIGUITY_MARGIN) return null
  return top
}

function buildChangeIndex(changes: CatalogChange[], scopedIds?: Set<string>) {
  const obsolete = new Map<string, ObsoleteMapEntry>()
  const modifiedVersions = new Map<string, number>() // featureId -> 发布后的最新版本
  changes
    .filter(change => !scopedIds || scopedIds.has(change.id))
    .forEach(change => {
      change.obsolete.forEach(entry => obsolete.set(entry.featureId, {
        label: entry.label, kind: entry.kind, replacementIds: [...entry.replacementIds]
      }))
      change.modified.forEach(entry => modifiedVersions.set(entry.featureId, entry.toVersion))
    })
  return { obsolete, modifiedVersions }
}

function suspend(feature: Feature, fromCatalogId: string, fromLabel: string, candidates: CatalogFeature[], reason: string, detectedAt: string): Feature {
  const pending: PendingLink = {
    changeId: '',
    fromCatalogId,
    fromCatalogLabel: fromLabel,
    candidateIds: candidates.map(item => item.id),
    reason,
    detectedAt
  }
  return { ...feature, linkStatus: 'pending', pending }
}

function toSuspension(feature: Feature): SyncSuspension | null {
  if (!feature.pending) return null
  return {
    featureId: feature.id,
    featureLabel: feature.label,
    fromCatalogId: feature.pending.fromCatalogId,
    candidateIds: feature.pending.candidateIds,
    reason: feature.pending.reason
  }
}

/**
 * 对单个案件做对应。不写存储、不抛业务错（除注入故障外），
 * 调用方拿到结果后再整体提交；任一异常时调用方保留原状态即可实现“退回处理前”。
 */
export function reconcileCase(input: ReconcileInput): ReconcileResult {
  if (input.fault) throw input.fault

  const { features, catalog, changes, changeIds, detectedAt } = input
  const activeMap = new Map(catalog.filter(item => item.status === 'active').map(item => [item.id, item]))
  const scope = changeIds?.length ? new Set(changeIds) : undefined
  const { obsolete, modifiedVersions } = buildChangeIndex(changes, scope)

  const autoLinked: SyncAutoLink[] = []
  const suspended: SyncSuspension[] = []

  const nextFeatures = features.map(original => {
    // 本案件自定义特征与已确认挂起但未重试的条目：重试入口只处理 pending，故此处 pending 也要继续走
    if (original.linkStatus === 'local' || !original.catalogFeatureId) return original
    const catalogId = original.catalogFeatureId

    // 1) 旧条目已停用（拆分 / 移除）
    const obsoleteEntry = obsolete.get(catalogId)
    if (obsoleteEntry) {
      const replacementCandidates = obsoleteEntry.replacementIds
        .map(id => activeMap.get(id))
        .filter((item): item is CatalogFeature => !!item)

      // 拆分场景：只有一条后继时直接按唯一候选评分；多条时用相似度仲裁
      if (obsoleteEntry.kind === 'split' && replacementCandidates.length === 1) {
        const only = replacementCandidates[0]
        const score = scoreCandidate(original, only)
        if (score >= AUTO_LINK_THRESHOLD) {
          autoLinked.push(autoLink(original, catalogId, only, score, 'replacement'))
          return linked(original, only)
        }
      }

      const match = findUniqueMatch(original, replacementCandidates)
      if (match) {
        autoLinked.push(autoLink(original, catalogId, match.candidate, match.score, 'replacement'))
        return linked(original, match.candidate)
      }

      const reason = !replacementCandidates.length
        ? `特征表已${obsoleteEntry.kind === 'split' ? '拆分/停用' : '停用'}“${obsoleteEntry.label}”，没有可直接对应的新条目。`
        : replacementCandidates.length === 1
          ? `特征表已将“${obsoleteEntry.label}”拆为“${replacementCandidates[0].label}”等，但本特征文字与新定义相似度不足，需代理人确认。`
          : `特征表已将“${obsoleteEntry.label}”拆分为 ${replacementCandidates.length} 个新条目，无法唯一对应，需代理人选择。`
      const updated = suspend(original, catalogId, obsoleteEntry.label, replacementCandidates, reason, detectedAt)
      const row = toSuspension(updated)
      if (row) suspended.push(row)
      return updated
    }

    // 2) 旧条目仍在，但定义改过：按新定义重新核对
    const newVersion = modifiedVersions.get(catalogId)
    if (newVersion !== undefined && original.linkedCatalogVersion !== newVersion) {
      const current = activeMap.get(catalogId)
      if (!current) return original
      const score = scoreCandidate(original, current)
      if (score >= AUTO_LINK_THRESHOLD) {
        autoLinked.push(autoLink(original, catalogId, current, score, 'redefine'))
        return { ...original, linkedCatalogVersion: current.version }
      }
      const candidates = [current]
      const updated = suspend(
        original, catalogId, current.label, candidates,
        `特征表已修改“${current.label}”的定义（v${original.linkedCatalogVersion ?? 1} → v${current.version}），本特征文字与新定义差异较大，请代理人确认仍指向该条目。`,
        detectedAt
      )
      const row = toSuspension(updated)
      if (row) suspended.push(row)
      return updated
    }

    // 3) 全量核对（无指定变更 / 重试）：引用的条目在表中已不存在
    if (!scope) {
      if (!activeMap.has(catalogId)) {
        const catalogEntry = catalog.find(item => item.id === catalogId)
        const fromLabel = catalogEntry?.label || original.label
        const updated = suspend(original, catalogId, fromLabel, [], '特征表中已找不到该条目，需要代理人重新指定或转为本案件自定义特征。', detectedAt)
        const row = toSuspension(updated)
        if (row) suspended.push(row)
        return updated
      }
      // 重试挂起条目：候选里再尝试一次唯一匹配（代理人可能已经编辑过特征文字）
      if (original.linkStatus === 'pending' && original.pending) {
        const candidates = original.pending.candidateIds
          .map(id => activeMap.get(id))
          .filter((item): item is CatalogFeature => !!item)
        const match = findUniqueMatch(original, candidates)
        if (match) {
          autoLinked.push(autoLink(original, catalogId === match.candidate.id ? original.pending.fromCatalogId : catalogId, match.candidate, match.score, catalogId === match.candidate.id ? 'redefine' : 'replacement'))
          return linked(original, match.candidate)
        }
      }
    } else if (original.linkStatus === 'pending' && original.pending) {
      // 带变更范围的重试：同样再试一次
      const candidates = original.pending.candidateIds
        .map(id => activeMap.get(id))
        .filter((item): item is CatalogFeature => !!item)
      const match = findUniqueMatch(original, candidates)
      if (match) {
        autoLinked.push(autoLink(original, original.pending.fromCatalogId, match.candidate, match.score, match.candidate.id === catalogId ? 'redefine' : 'replacement'))
        return linked(original, match.candidate)
      }
      const row = toSuspension(original)
      if (row) suspended.push(row)
    }

    return original
  })

  // 回填 pending.changeId（当前范围内第一条涉及该旧条目的变更）
  const changeIdByFeature = new Map<string, string>()
  changes.forEach(change => {
    if (scope && !scope.has(change.id)) return
    change.obsolete.forEach(entry => changeIdByFeature.set(entry.featureId, change.id))
    change.modified.forEach(entry => changeIdByFeature.set(entry.featureId, change.id))
  })
  nextFeatures.forEach(feature => {
    if (feature.pending && !feature.pending.changeId) {
      feature.pending.changeId = changeIdByFeature.get(feature.pending.fromCatalogId) || ''
    }
  })

  return { features: nextFeatures, autoLinked, suspended }
}

function linked(original: Feature, target: CatalogFeature): Feature {
  return { ...original, catalogFeatureId: target.id, linkStatus: 'linked', pending: null, linkedCatalogVersion: target.version }
}

function autoLink(original: Feature, fromCatalogId: string, target: CatalogFeature, score: number, via: 'replacement' | 'redefine'): SyncAutoLink {
  return {
    featureId: original.id,
    featureLabel: original.label,
    fromCatalogId,
    toCatalogId: target.id,
    toLabel: target.label,
    score,
    via
  }
}
