import { Injectable } from '@angular/core'
import { BehaviorSubject, map } from 'rxjs'
import type {
  Annotation,
  CaseRecord,
  CaseSyncStatus,
  CatalogDraft,
  CatalogFeature,
  Claim,
  ClaimVersion,
  Feature,
  Paragraph,
  Role,
  SyncReportEntry,
  ValidationIssue,
  WorkbenchState
} from './models'
import { demoStateV2, migrateV1 } from './seed'
import { reconcileCase } from './reconcile'

const STORAGE_KEY = 'patent-claim-mapping-workbench-v2'
const OLD_STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
const POSITION_KEY = 'patent-claim-mapping-position-v2'
const OLD_POSITION_KEY = 'patent-claim-mapping-position-v1'

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
function clone<T>(value: T): T { return structuredClone(value) }

@Injectable({ providedIn: 'root' })
export class WorkbenchService {
  private readonly initialState = this.loadState()
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.initialState)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private past: WorkbenchState[] = []
  private future: WorkbenchState[] = []

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly catalog$ = this.state$.pipe(map(state => state.catalog))
  readonly catalogChanges$ = this.state$.pipe(map(state => state.catalogChanges))
  readonly catalogDrafts$ = this.state$.pipe(map(state => state.catalogDrafts))
  readonly cases$ = this.state$.pipe(map(state => state.cases))
  readonly syncReport$ = this.state$.pipe(map(state => state.lastSyncReport))

  readonly activeCase$ = this.state$.pipe(map(state => state.cases.find(item => item.id === state.activeCaseId) || state.cases[0]))
  readonly claims$ = this.activeCase$.pipe(map(c => c.claims))
  readonly paragraphs$ = this.activeCase$.pipe(map(c => c.paragraphs))
  readonly features$ = this.activeCase$.pipe(map(c => c.features))
  readonly annotations$ = this.activeCase$.pipe(map(c => c.annotations))
  readonly selectedClaim$ = this.activeCase$.pipe(map(c => c.claims.find(claim => claim.id === c.selectedClaimId) || c.claims[0]))
  readonly selectedFeature$ = this.activeCase$.pipe(map(c => c.features.find(feature => feature.id === c.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get state(): WorkbenchState { return this.stateSubject.value }
  get activeCase(): CaseRecord {
    const state = this.stateSubject.value
    return state.cases.find(item => item.id === state.activeCaseId) || state.cases[0]
  }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  // ── 案件切换与新建 ──────────────────────────────────────────────

  selectCase(id: string): void {
    this.patchState(state => { state.activeCaseId = id })
  }

  addCase(): void {
    this.commit(state => {
      const count = state.cases.length + 1
      const claim: Claim = { id: uid('claim'), number: 1, title: `新案件权利要求 ${count}`, independent: true, text: '请录入权利要求正文。' }
      const caseRecord: CaseRecord = {
        id: uid('case'), name: `新案件 ${count}`, applicationNo: `CN-NEW-${count}`, agentName: state.role === 'examiner' ? '审查员' : '代理人',
        claims: [claim], paragraphs: [], features: [], annotations: [], orphanMappings: [], versions: [],
        selectedClaimId: claim.id, selectedFeatureId: null,
        lastReconcileAt: null, lastReconcileStatus: 'never', lastReconcileError: null
      }
      state.cases.push(caseRecord)
      state.activeCaseId = caseRecord.id
    })
  }

  updateActiveCase(patch: Partial<Pick<CaseRecord, 'name' | 'applicationNo' | 'agentName'>>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => { Object.assign(this.active(state), patch) })
  }

  // ── 视图状态 ────────────────────────────────────────────────────

  selectClaim(id: string): void {
    this.patchState(state => {
      const target = this.active(state)
      target.selectedClaimId = id
      target.selectedFeatureId = target.features.find(feature => feature.claimId === id)?.id || null
      this.saveState()
    })
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { this.active(state).selectedFeatureId = id; this.saveState() })
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
  }

  // ── 权利要求 / 段落 ─────────────────────────────────────────────

  updateClaim(patch: Partial<Claim>): void {
    this.commit(state => {
      const target = this.active(state)
      const claim = target.claims.find(item => item.id === target.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const target = this.active(state)
      const number = Math.max(0, ...target.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: uid('claim'), number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      target.claims.push(claim)
      target.selectedClaimId = claim.id
      target.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const target = this.active(state)
      const next = target.paragraphs.length + 1
      target.paragraphs.push({ id: uid('para'), section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const paragraph = this.active(state).paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const target = this.active(state)
      target.paragraphs = target.paragraphs.filter(item => item.id !== id)
      target.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      target.orphanMappings = target.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  // ── 案件特征 ────────────────────────────────────────────────────

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const target = this.active(state)
      const feature: Feature = {
        id: uid('feature'), claimId: target.selectedClaimId,
        label: `新特征 ${target.features.filter(item => item.claimId === target.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: state.role,
        catalogFeatureId: null, linkStatus: 'local', pending: null, linkedCatalogVersion: null
      }
      target.features.push(feature)
      target.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = this.active(state).features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const target = this.active(state)
      const feature = target.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => target.orphanMappings.push({
        id: uid('orphan'), featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      target.features = target.features.filter(item => item.id !== id)
      target.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      target.annotations = target.annotations.filter(item => item.featureId !== id)
      target.selectedFeatureId = target.features.find(item => item.claimId === target.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = this.active(state).features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      const target = this.active(state)
      target.orphanMappings = target.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { this.active(state).orphanMappings = this.active(state).orphanMappings.filter(item => item.id !== id) })
  }

  // ── 批注 ────────────────────────────────────────────────────────

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    const names: Record<Role, string> = { author: '代理人', examiner: '审查员 · 李岚', viewer: '观察者' }
    const targetCase = this.activeCase
    this.commit(state => {
      this.active(state).annotations.push({
        id: uid('annotation'), featureId, authorRole: role,
        authorName: role === 'author' ? `代理人 · ${targetCase.agentName}` : names[role],
        text: trimmed, updatedAt: new Date().toISOString()
      })
    })
  }

  updateAnnotation(id: string, text: string): void {
    this.commit(state => {
      const annotation = this.active(state).annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    this.commit(state => {
      const targetCase = this.active(state)
      const annotation = targetCase.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) targetCase.annotations = targetCase.annotations.filter(item => item.id !== id)
    })
  }

  // ── 特征表（所内统一维护） ──────────────────────────────────────

  get canAdminCatalog(): boolean { return this.stateSubject.value.role === 'author' }

  addCatalogFeature(): void {
    if (!this.canAdminCatalog) return
    this.commit(state => {
      const stamp = new Date().toISOString()
      state.catalog.push({
        id: uid('cat'), code: `JT-${state.catalog.filter(item => item.status === 'active').length + 1}`,
        label: '新特征条目', definition: '', category: '未分类',
        status: 'active', version: 1, createdAt: stamp, updatedAt: stamp
      })
    })
  }

  updateCatalogFeature(id: string, patch: Partial<Pick<CatalogFeature, 'code' | 'label' | 'definition' | 'category'>>): void {
    if (!this.canAdminCatalog) return
    this.commit(state => {
      const feature = state.catalog.find(item => item.id === id)
      if (feature && feature.status === 'active') Object.assign(feature, patch)
    })
  }

  addDraft(kind: CatalogDraft['kind'], featureId: string): void {
    if (!this.canAdminCatalog) return
    const feature = this.stateSubject.value.catalog.find(item => item.id === featureId)
    if (!feature || feature.status !== 'active') return
    this.commit(state => {
      if (state.catalogDrafts.some(item => item.featureId === featureId && item.kind === kind)) return
      const stamp = new Date().toISOString()
      const base = {
        id: uid('draft'), kind, featureId, targetLabel: feature.label, newCategory: feature.category, createdAt: stamp
      } as CatalogDraft
      if (kind === 'redefine') {
        base.newLabel = feature.label
        base.newDefinition = feature.definition
      } else if (kind === 'split') {
        base.newLabel = ''
        base.newDefinition = ''
        base.splitParts = [
          { label: `${feature.label}（一）`, definition: '', category: feature.category },
          { label: `${feature.label}（二）`, definition: '', category: feature.category }
        ]
      } else {
        base.newLabel = ''
        base.newDefinition = ''
      }
      state.catalogDrafts.push(base)
    })
  }

  updateDraft(id: string, patch: Partial<CatalogDraft>): void {
    if (!this.canAdminCatalog) return
    this.commit(state => {
      const draft = state.catalogDrafts.find(item => item.id === id)
      if (draft) Object.assign(draft, patch)
    })
  }

  updateDraftPart(draftId: string, index: number, patch: Partial<{ label: string; definition: string; category: string }>): void {
    if (!this.canAdminCatalog) return
    this.commit(state => {
      const draft = state.catalogDrafts.find(item => item.id === draftId)
      if (draft?.splitParts?.[index]) Object.assign(draft.splitParts[index], patch)
    })
  }

  removeDraft(id: string): void {
    if (!this.canAdminCatalog) return
    this.commit(state => { state.catalogDrafts = state.catalogDrafts.filter(item => item.id !== id) })
  }

  /**
   * 发布暂存变更：特征表改定义/拆分/停用在一个事务里落定，
   * 随后逐案件做对应；任一案件失败只回滚该案件并记入报告，其他案件与特征表不受影响。
   */
  publishCatalog(note: string): void {
    if (!this.canAdminCatalog) return
    if (!this.stateSubject.value.catalogDrafts.length) return
    this.commit(state => {
      const stamp = new Date().toISOString()
      const change = {
        id: uid('change'), releasedAt: stamp, releasedBy: state.role,
        note: note.trim() || `特征表发布 ${new Date(stamp).toLocaleString('zh-CN', { hour12: false })}`,
        obsolete: [], modified: [], addedFeatureIds: []
      } as WorkbenchState['catalogChanges'][number]

      state.catalogDrafts.forEach(draft => {
        const feature = state.catalog.find(item => item.id === draft.featureId)
        if (!feature || feature.status !== 'active') return
        if (draft.kind === 'redefine') {
          const fromVersion = feature.version
          feature.label = draft.newLabel.trim() || feature.label
          feature.definition = draft.newDefinition
          feature.category = draft.newCategory
          feature.version += 1
          feature.updatedAt = stamp
          change.modified.push({ featureId: feature.id, fromVersion, toVersion: feature.version })
        } else if (draft.kind === 'split') {
          const parts = (draft.splitParts || []).filter(part => part.label.trim())
          if (!parts.length) return
          const replacementIds: string[] = []
          parts.forEach((part, index) => {
            const id = uid('cat')
            state.catalog.push({
              id, code: `${feature.code}-${index + 1}`, label: part.label.trim(), definition: part.definition,
              category: part.category || feature.category, status: 'active', version: 1, createdAt: stamp, updatedAt: stamp
            })
            replacementIds.push(id)
            change.addedFeatureIds.push(id)
          })
          feature.status = 'obsolete'
          feature.updatedAt = stamp
          change.obsolete.push({ featureId: feature.id, label: feature.label, kind: 'split', replacementIds })
        } else {
          feature.status = 'obsolete'
          feature.updatedAt = stamp
          change.obsolete.push({ featureId: feature.id, label: feature.label, kind: 'remove', replacementIds: [] })
        }
      })

      if (!change.obsolete.length && !change.modified.length) {
        state.catalogDrafts = []
        return
      }
      state.catalogChanges.unshift(change)
      state.catalogDrafts = []
      this.reconcileAllCases(state, [change.id], stamp)
    })
  }

  /** 按案件重试：只重新处理仍挂起/引用失效的特征，失败时整案退回处理前 */
  retryCase(caseId: string): void {
    if (!this.canAdminCatalog) return
    const target = this.stateSubject.value.cases.find(item => item.id === caseId)
    if (!target) return
    const hasUnresolved = target.features.some(feature =>
      feature.linkStatus === 'pending' ||
      (!!feature.catalogFeatureId && !this.stateSubject.value.catalog.some(item => item.id === feature.catalogFeatureId && item.status === 'active'))
    )
    if (!hasUnresolved) return
    this.commit(state => {
      const caseRecord = state.cases.find(item => item.id === caseId)
      if (!caseRecord) return
      const before = clone(caseRecord.features)
      const fault = state.failNextCaseId === caseId
        ? new Error(`模拟故障：案件“${caseRecord.name}”重试过程中断（验证按案件回滚）。`)
        : null
      if (fault) state.failNextCaseId = null
      const stamp = new Date().toISOString()
      try {
        const result = reconcileCase({
          caseId, features: caseRecord.features, catalog: state.catalog,
          changes: state.catalogChanges, detectedAt: stamp, fault
        })
        caseRecord.features = result.features
        caseRecord.lastReconcileAt = stamp
        caseRecord.lastReconcileStatus = result.suspended.length ? 'has-pending' : 'ok'
        caseRecord.lastReconcileError = null
        this.appendReport(state, {
          caseId, caseName: caseRecord.name, status: 'success', ranAt: stamp,
          changeIds: Array.from(new Set(caseRecord.features.map(f => f.pending?.changeId || '').filter(Boolean))),
          autoLinked: result.autoLinked, suspended: result.suspended, error: null
        })
      } catch (error) {
        caseRecord.features = before
        caseRecord.lastReconcileAt = stamp
        caseRecord.lastReconcileStatus = 'failed'
        caseRecord.lastReconcileError = (error as Error).message
        this.appendReport(state, {
          caseId, caseName: caseRecord.name, status: 'failed', ranAt: stamp, changeIds: [],
          autoLinked: [], suspended: [], error: (error as Error).message
        })
      }
    })
  }

  armFaultForCase(caseId: string | null): void {
    this.patchState(state => { state.failNextCaseId = caseId })
  }

  /** 代理人确认挂起引用：选定新条目，或明确转为本案件自定义特征 */
  resolvePending(featureId: string, targetCatalogId: string | null): void {
    if (this.stateSubject.value.role !== 'author') return
    this.commit(state => {
      const targetCase = this.active(state)
      const feature = targetCase.features.find(item => item.id === featureId)
      if (!feature || !feature.pending) return
      if (targetCatalogId) {
        const target = state.catalog.find(item => item.id === targetCatalogId && item.status === 'active')
        if (!target) return
        feature.catalogFeatureId = target.id
        feature.linkStatus = 'linked'
        feature.linkedCatalogVersion = target.version
        feature.pending = null
      } else {
        feature.catalogFeatureId = null
        feature.linkStatus = 'local'
        feature.linkedCatalogVersion = null
        feature.pending = null
      }
      targetCase.lastReconcileStatus = targetCase.features.some(item => item.pending) ? 'has-pending' : 'ok'
    })
  }

  /** 代理人手动把案件特征对到某个特征表条目（也用于挂起时不在候选集里的手动选择） */
  linkFeatureToCatalog(featureId: string, catalogId: string): void {
    if (this.stateSubject.value.role !== 'author') return
    this.commit(state => {
      const targetCase = this.active(state)
      const feature = targetCase.features.find(item => item.id === featureId)
      const target = state.catalog.find(item => item.id === catalogId && item.status === 'active')
      if (!feature || !target) return
      feature.catalogFeatureId = target.id
      feature.linkStatus = 'linked'
      feature.linkedCatalogVersion = target.version
      feature.pending = null
      targetCase.lastReconcileStatus = targetCase.features.some(item => item.pending) ? 'has-pending' : 'ok'
    })
  }

  unlinkFeature(featureId: string): void {
    if (this.stateSubject.value.role !== 'author') return
    this.commit(state => {
      const feature = this.active(state).features.find(item => item.id === featureId)
      if (!feature) return
      feature.catalogFeatureId = null
      feature.linkStatus = 'local'
      feature.linkedCatalogVersion = null
      feature.pending = null
    })
  }

  // ── 版本快照 ────────────────────────────────────────────────────

  createVersion(name?: string): void {
    this.commit(state => {
      const target = this.active(state)
      target.versions.unshift({
        id: uid('version'), name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(target.claims), features: clone(target.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const target = this.active(state)
      const version = target.versions.find(item => item.id === id)
      if (!version) return
      target.claims = clone(version.claims)
      target.features = clone(version.features)
      if (!target.claims.some(claim => claim.id === target.selectedClaimId)) target.selectedClaimId = target.claims[0]?.id || ''
      target.selectedFeatureId = target.features.find(feature => feature.claimId === target.selectedClaimId)?.id || null
      // 恢复历史快照后再按当前特征表核一遍，避免依据/引用落在已失效条目上
      const result = reconcileCase({
        caseId: target.id, features: target.features, catalog: state.catalog,
        changes: state.catalogChanges, detectedAt: new Date().toISOString()
      })
      target.features = result.features
      target.lastReconcileStatus = result.suspended.length ? 'has-pending' : 'ok'
    })
  }

  // ── 撤销重做 / 持久化 ───────────────────────────────────────────

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(clone(this.stateSubject.value))
    this.stateSubject.next(previous)
    this.updateHistory()
    this.saveState()
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(clone(this.stateSubject.value))
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(POSITION_KEY, JSON.stringify({ scrollY: window.scrollY }))
    this.saveState()
  }

  readPosition(): number {
    if (typeof localStorage === 'undefined') return 0
    try { return (JSON.parse(localStorage.getItem(POSITION_KEY) || '{}') as { scrollY?: number }).scrollY || 0 } catch { return 0 }
  }

  exportJson(): string {
    return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.stateSubject.value) }, null, 2)
  }

  exportCsv(): string {
    const state = this.stateSubject.value
    const target = this.active(state)
    const rows = target.features.map(feature => [
      target.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      target.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => target.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => target.paragraphs.find(item => item.id === id)?.section || id).join('；'),
      feature.linkStatus === 'linked' ? state.catalog.find(item => item.id === feature.catalogFeatureId)?.code || '' : feature.linkStatus === 'pending' ? '待确认' : '本案件自定义'
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落', '特征表引用'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  // ── 校验 ────────────────────────────────────────────────────────

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const targetCase = state.cases.find(item => item.id === state.activeCaseId) || state.cases[0]
    if (!targetCase) return issues
    for (const feature of targetCase.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, targetCase.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
      if (feature.linkStatus === 'pending' && feature.pending) {
        issues.push({
          id: `pending-${feature.id}`, severity: 'error', type: 'pending-link', featureId: feature.id,
          title: `${feature.label} 等待重新对应特征表`,
          detail: `${feature.pending.reason} 说明书依据已保留，请确认后重新建立引用。`
        })
      }
      if (feature.linkStatus === 'linked' && feature.catalogFeatureId && !state.catalog.some(item => item.id === feature.catalogFeatureId && item.status === 'active')) {
        issues.push({
          id: `broken-${feature.id}`, severity: 'error', type: 'broken-catalog-link', featureId: feature.id,
          title: `${feature.label} 的特征表引用已失效`,
          detail: '引用的特征表条目不存在或已停用，请重新对应或转为本案件自定义特征。'
        })
      }
    }
    targetCase.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    return issues
  }

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }

  // ── 内部工具 ────────────────────────────────────────────────────

  private active(state: WorkbenchState): CaseRecord {
    return state.cases.find(item => item.id === state.activeCaseId) || state.cases[0]
  }

  private appendReport(state: WorkbenchState, entry: SyncReportEntry): void {
    state.lastSyncReport = [entry, ...state.lastSyncReport.filter(item => !(item.caseId === entry.caseId && item.ranAt === entry.ranAt))].slice(0, 30)
  }

  private reconcileAllCases(state: WorkbenchState, changeIds: string[], stamp: string): void {
    const report: SyncReportEntry[] = []
    for (const caseRecord of state.cases) {
      const before = clone(caseRecord.features)
      const fault = state.failNextCaseId === caseRecord.id
        ? new Error(`模拟故障：案件“${caseRecord.name}”对应过程中断，已回滚该案件，其他案件与特征表保留。`)
        : null
      if (fault) state.failNextCaseId = null
      try {
        const result = reconcileCase({
          caseId: caseRecord.id, features: caseRecord.features, catalog: state.catalog,
          changes: state.catalogChanges, changeIds, detectedAt: stamp, fault
        })
        caseRecord.features = result.features
        caseRecord.lastReconcileAt = stamp
        caseRecord.lastReconcileStatus = this.statusFromResult(result.suspended.length)
        caseRecord.lastReconcileError = null
        report.push({
          caseId: caseRecord.id, caseName: caseRecord.name, status: 'success', ranAt: stamp,
          changeIds, autoLinked: result.autoLinked, suspended: result.suspended, error: null
        })
      } catch (error) {
        // 失败只回滚这一个案件，特征表与其他案件保持已发布状态
        caseRecord.features = before
        caseRecord.lastReconcileAt = stamp
        caseRecord.lastReconcileStatus = 'failed'
        caseRecord.lastReconcileError = (error as Error).message
        report.push({
          caseId: caseRecord.id, caseName: caseRecord.name, status: 'failed', ranAt: stamp,
          changeIds, autoLinked: [], suspended: [], error: (error as Error).message
        })
      }
    }
    state.lastSyncReport = report
  }

  private statusFromResult(suspendedCount: number): CaseSyncStatus {
    return suspendedCount ? 'has-pending' : 'ok'
  }

  private commit(recipe: (state: WorkbenchState) => void): void {
    const current = clone(this.stateSubject.value)
    const next = clone(current)
    recipe(next)
    this.past.push(current)
    if (this.past.length > 60) this.past.shift()
    this.future = []
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    const next = clone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
    this.saveState()
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }

  private saveState(): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateSubject.value))
  }

  private loadState(): WorkbenchState {
    if (typeof localStorage === 'undefined') return demoStateV2()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<WorkbenchState>
        if (parsed.version === 2) return { ...demoStateV2(parsed.role || 'author'), ...parsed }
      }
      // 旧工作台数据先升级为引用特征表的结构再参与对应
      const legacy = localStorage.getItem(OLD_STORAGE_KEY)
      if (legacy) {
        const migrated = migrateV1(JSON.parse(legacy) as Record<string, unknown>, 'author')
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
        localStorage.removeItem(OLD_STORAGE_KEY)
        localStorage.removeItem(OLD_POSITION_KEY)
        return migrated
      }
      return demoStateV2()
    } catch {
      return demoStateV2()
    }
  }
}
