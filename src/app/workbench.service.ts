import { Injectable } from '@angular/core'
import { BehaviorSubject, map } from 'rxjs'
import type {
  Annotation, CaseFile, Claim, ClaimVersion, Feature, MasterFeature,
  Paragraph, PendingLink, Position, Role, ValidationIssue, WorkbenchState
} from './models'
import { caseAlpha, legacyV1State, seedState, tableRevision1 } from './seed'
import { applyPlan, buildPlan, caseNeedsSync, caseStaleFeatures, migrateLegacyState, resolvePendingLink, scoreCandidates } from './sync-engine'

const STORAGE_KEY = 'patent-claim-mapping-workbench-v2'
const LEGACY_STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
const POSITION_KEY = 'patent-claim-mapping-position-v2'

function clone<T>(value: T): T { return structuredClone(value) }
function uid(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`}

export interface SyncRunReport {
  processed: Array<{ caseId: string; ok: boolean; auto: number; pending: number; error: string | null }>
}

@Injectable({ providedIn: 'root' })
export class WorkbenchService {
  private readonly initialState = this.loadState()
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.initialState)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private past: WorkbenchState[] = []
  private future: WorkbenchState[] = []

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly table$ = this.state$.pipe(map(state => state.table))
  readonly cases$ = this.state$.pipe(map(state => state.cases))
  readonly activeCase$ = this.state$.pipe(map(state => state.cases.find(item => item.id === state.activeCaseId) || state.cases[0]))
  readonly claims$ = this.activeCase$.pipe(map(caseFile => caseFile.claims))
  readonly paragraphs$ = this.activeCase$.pipe(map(caseFile => caseFile.paragraphs))
  readonly features$ = this.activeCase$.pipe(map(caseFile => caseFile.features))
  readonly annotations$ = this.activeCase$.pipe(map(caseFile => caseFile.annotations))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.activeCase$.pipe(map(caseFile => caseFile.claims.find(claim => claim.id === caseFile.selectedClaimId) || caseFile.claims[0]))
  readonly selectedFeature$ = this.activeCase$.pipe(map(caseFile => caseFile.features.find(feature => feature.id === caseFile.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validateActive(state)))

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.savePosition())
    }
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  private activeIndex(state: WorkbenchState): number {
    const index = state.cases.findIndex(item => item.id === state.activeCaseId)
    return index >= 0 ? index : 0
  }

  // ---------- 案件 / 视图导航 ----------

  selectCase(id: string): void {
    this.patchState(state => {
      if (!state.cases.some(item => item.id === id)) return
      state.activeCaseId = id
    })
    this.savePosition()
  }

  setView(view: 'case' | 'table'): void {
    this.patchState(state => { state.view = view })
    this.savePosition()
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
  }

  addCase(): void {
    const caseFile: CaseFile = {
      id: uid('case'), name: `新案件 ${new Date().toLocaleDateString('zh-CN')}`, agent: '本机代理人',
      claims: [], paragraphs: [], features: [], annotations: [], orphanMappings: [], versions: [], pendingLinks: [],
      sync: { status: 'synced', alignedRevision: this.stateSubject.value.table.revision, lastRunAt: null, lastError: null, attemptedRevision: null, autoSwitchLog: [] },
      selectedClaimId: '', selectedFeatureId: null
    }
    this.commit(state => {
      state.cases.push(caseFile)
      state.activeCaseId = caseFile.id
      state.view = 'case'
    })
  }

  selectClaim(id: string): void {
    this.patchState(state => {
      const caseFile = state.cases[this.activeIndex(state)]
      caseFile.selectedClaimId = id
      caseFile.selectedFeatureId = caseFile.features.find(feature => feature.claimId === id)?.id || null
    })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.cases[this.activeIndex(state)].selectedFeatureId = id })
    this.savePosition()
  }

  // ---------- 案件内：权利要求 / 段落 / 特征 / 批注 ----------

  updateClaim(patch: Partial<Claim>): void {
    this.commitActive(caseFile => {
      const claim = caseFile.claims.find(item => item.id === caseFile.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commitActive(caseFile => {
      const number = Math.max(0, ...caseFile.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: uid('claim'), number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      caseFile.claims.push(claim)
      caseFile.selectedClaimId = claim.id
      caseFile.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const next = caseFile.paragraphs.length + 1
      caseFile.paragraphs.push({ id: uid('para'), section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const paragraph = caseFile.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      caseFile.paragraphs = caseFile.paragraphs.filter(item => item.id !== id)
      caseFile.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      caseFile.orphanMappings = caseFile.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const feature: Feature = {
        id: uid('feature'), claimId: caseFile.selectedClaimId,
        label: `新特征 ${caseFile.features.filter(item => item.claimId === caseFile.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: this.stateSubject.value.role,
        tableFeatureId: null, alignedRevision: null
      }
      caseFile.features.push(feature)
      caseFile.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const feature = caseFile.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const feature = caseFile.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => caseFile.orphanMappings.push({
        id: uid('orphan'), featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      caseFile.features = caseFile.features.filter(item => item.id !== id)
      caseFile.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      caseFile.annotations = caseFile.annotations.filter(item => item.featureId !== id)
      // 挂起记录不允许落到已不存在的特征上
      caseFile.pendingLinks = caseFile.pendingLinks.filter(link => link.featureId !== id)
      caseFile.selectedFeatureId = caseFile.features.find(item => item.claimId === caseFile.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commitActive(caseFile => {
      const feature = caseFile.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      caseFile.orphanMappings = caseFile.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commitActive(caseFile => { caseFile.orphanMappings = caseFile.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    const names: Record<Role, string> = { author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' }
    this.commitActive(caseFile => caseFile.annotations.push({
      id: uid('annotation'), featureId, authorRole: role, authorName: names[role], text: trimmed, updatedAt: new Date().toISOString()
    }))
  }

  updateAnnotation(id: string, text: string): void {
    this.commitActive(caseFile => {
      const annotation = caseFile.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === this.stateSubject.value.role) annotation.text = text
    })
  }

  deleteAnnotation(id: string): void {
    this.commitActive(caseFile => {
      const annotation = caseFile.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === this.stateSubject.value.role) {
        caseFile.annotations = caseFile.annotations.filter(item => item.id !== id)
      }
    })
  }

  createVersion(name?: string): void {
    this.commitActive(caseFile => {
      caseFile.versions.unshift({
        id: uid('version'), name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(caseFile.claims), features: clone(caseFile.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commitActive((caseFile, state) => {
      const version = caseFile.versions.find(item => item.id === id)
      if (!version) return
      const restoredIds = new Set(version.features.map(feature => feature.id))
      caseFile.claims = clone(version.claims)
      caseFile.features = clone(version.features)
      // 版本恢复后清理指向已消失特征的批注与挂起，防止依据/挂起落空
      caseFile.annotations = caseFile.annotations.filter(item => restoredIds.has(item.featureId))
      caseFile.pendingLinks = caseFile.pendingLinks.filter(link => restoredIds.has(link.featureId))
      if (!caseFile.claims.some(claim => claim.id === caseFile.selectedClaimId)) {
        caseFile.selectedClaimId = caseFile.claims[0]?.id || ''
      }
      caseFile.selectedFeatureId = caseFile.features.find(feature => feature.claimId === caseFile.selectedClaimId)?.id || null
      caseFile.sync.status = caseNeedsSync(caseFile, state.table) ? 'out-of-sync' : 'synced'
    })
  }

  // ---------- 特征表（所级统一维护） ----------

  updateMasterMeta(id: string, patch: Partial<Pick<MasterFeature, 'code' | 'label'>>): void {
    this.commit(state => {
      const master = state.table.features.find(item => item.id === id)
      if (master && master.status === 'active') Object.assign(master, patch)
    })
  }

  addMasterFeature(code: string, label: string, definition: string): void {
    const trimmed = definition.trim()
    if (!trimmed) return
    this.commit(state => {
      state.table.features.push(this.makeMaster(state.table.revision, code.trim() || `T${state.table.features.length + 1}`, label.trim() || '未命名特征', trimmed, {}))
    })
  }

  /** 改掉定义：旧条目退役，新定义唯一生效，引用旧条目的案件按新定义重新对上 */
  redefineMaster(id: string, code: string, label: string, definition: string): void {
    const trimmed = definition.trim()
    if (!trimmed) return
    this.commit(state => {
      const old = state.table.features.find(item => item.id === id)
      if (!old || old.status !== 'active') return
      state.table.revision += 1
      old.status = 'retired'
      old.replacedByIds = []
      const replacement = this.makeMaster(state.table.revision, code.trim() || `${old.code}1`, label.trim() || old.label, trimmed, { supersedesId: old.id })
      old.replacedByIds = [replacement.id]
      state.table.features.push(replacement)
      this.markCasesOutOfSync(state)
    })
  }

  /** 拆成两条或更多：旧条目退役，多个新生效条目并列 */
  splitMaster(id: string, parts: Array<{ code: string; label: string; definition: string }>): void {
    const valid = parts.map(part => ({ code: part.code.trim(), label: part.label.trim(), definition: part.definition.trim() })).filter(part => part.definition)
    if (!valid.length) return
    this.commit(state => {
      const old = state.table.features.find(item => item.id === id)
      if (!old || old.status !== 'active') return
      state.table.revision += 1
      old.status = 'retired'
      old.replacedByIds = []
      for (const part of valid) {
        const created = this.makeMaster(state.table.revision, part.code, part.label || '未命名特征', part.definition, { splitFromId: old.id })
        old.replacedByIds.push(created.id)
        state.table.features.push(created)
      }
      this.markCasesOutOfSync(state)
    })
  }

  /** 退役且无替代：引用它的案件必然无法自动对上，全部挂起 */
  retireMaster(id: string): void {
    this.commit(state => {
      const old = state.table.features.find(item => item.id === id)
      if (!old || old.status !== 'active') return
      state.table.revision += 1
      old.status = 'retired'
      old.replacedByIds = []
      this.markCasesOutOfSync(state)
    })
  }

  private makeMaster(revision: number, code: string, label: string, definition: string,
    links: { splitFromId?: string | null; supersedesId?: string | null }): MasterFeature {
    return {
      id: uid('mf'), code, label, definition, status: 'active', revision,
      splitFromId: links.splitFromId ?? null, supersedesId: links.supersedesId ?? null,
      replacedByIds: [], updatedAt: new Date().toISOString()
    }
  }

  private markCasesOutOfSync(state: WorkbenchState): void {
    for (const caseFile of state.cases) {
      if (caseFile.sync.status === 'synced' && caseStaleFeatures(caseFile, state.table).length > 0) {
        caseFile.sync.status = 'out-of-sync'
      }
    }
  }

  // ---------- 同步：唯一自动换 / 挂起 / 失败回退 / 按案件重试 ----------

  /** 演练开关：让指定案件下一次同步失败，验证按案件回退与重试 */
  toggleFailNext(caseId: string): void {
    this.patchState(state => {
      const set = new Set(state.failNextSyncCaseIds)
      set.has(caseId) ? set.delete(caseId) : set.add(caseId)
      state.failNextSyncCaseIds = [...set]
    })
  }

  /** 全部案件一起对齐；单个案件失败只回退该案件，其他案件与特征表照常生效 */
  syncAll(): SyncRunReport {
    return this.runSync(this.stateSubject.value.cases.map(item => item.id))
  }

  /** 按案件重试：该案件退回上次成功后的样子再评估；只补尚未对上的部分 */
  syncCase(caseId: string): SyncRunReport {
    return this.runSync([caseId])
  }

  private runSync(caseIds: string[]): SyncRunReport {
    const report: SyncRunReport = { processed: [] }
    this.commit(state => {
      const at = new Date().toISOString()
      for (const caseId of caseIds) {
        const index = state.cases.findIndex(item => item.id === caseId)
        if (index < 0) continue
        // 处理前快照：失败时整体退回，特征表与其他案件不动
        const before = clone(state.cases[index])
        try {
          const shouldFail = state.failNextSyncCaseIds.includes(caseId)
          const plan = buildPlan(state.cases[index], state.table, at)
          if (shouldFail) {
            state.failNextSyncCaseIds = state.failNextSyncCaseIds.filter(id => id !== caseId)
            throw new Error('处理中断：特征引用更新未完成（演练注入的失败）')
          }
          applyPlan(state.cases[index], plan, state.table.revision, at)
          report.processed.push({ caseId, ok: true, auto: plan.auto.length, pending: plan.pending.length, error: null })
        } catch (error) {
          // 回退本案件到处理前；重试时只评估仍引用退役条目的特征（即没对上的部分）
          state.cases[index] = before
          state.cases[index].sync.status = 'failed'
          state.cases[index].sync.lastError = error instanceof Error ? error.message : String(error)
          state.cases[index].sync.attemptedRevision = state.table.revision
          report.processed.push({ caseId, ok: false, auto: 0, pending: before.pendingLinks.length, error: state.cases[index].sync.lastError })
        }
      }
    })
    return report
  }

  /** 代理人确认挂起：改挂候选条目，或脱离特征表保留为案件本地特征 */
  resolvePending(linkId: string, choice: { type: 'pick'; tableFeatureId: string } | { type: 'detach' }): void {
    this.commitActive((caseFile, state) => {
      resolvePendingLink(caseFile, linkId, choice, state.table, new Date().toISOString())
    })
  }

  masterCandidatesForLink(link: PendingLink): ReturnType<typeof scoreCandidates> {
    const table = this.stateSubject.value.table
    const caseFile = this.stateSubject.value.cases.find(item => item.pendingLinks.some(linkItem => linkItem.id === link.id))
    const feature = caseFile?.features.find(item => item.id === link.featureId)
    const scoped = table.features.filter(master => master.status === 'active')
    return feature ? scoreCandidates(feature.text, scoped) : []
  }

  // ---------- 撤销重做 / 持久化 ----------

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
    const state = this.stateSubject.value
    const position: Position = { activeCaseId: state.activeCaseId, view: state.view, tab: state.activeTab, scrollY: window.scrollY }
    localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    this.saveState()
  }

  restorePosition(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(POSITION_KEY)
      if (!raw) return
      const position = JSON.parse(raw) as Partial<Position>
      this.patchState(state => {
        if (position.activeCaseId && state.cases.some(item => item.id === position.activeCaseId)) state.activeCaseId = position.activeCaseId
        if (position.view) state.view = position.view
        if (position.tab) state.activeTab = position.tab
      })
      setTimeout(() => window.scrollTo({ top: position.scrollY || 0, behavior: 'instant' as ScrollBehavior }), 0)
    } catch { /* 忽略损坏的位置信息 */ }
  }

  exportJson(): string {
    const state = this.stateSubject.value
    const caseFile = state.cases[this.activeIndex(state)]
    return JSON.stringify({ caseId: caseFile.id, caseName: caseFile.name, ...caseFile, tableRevision: state.table.revision, validationIssues: this.validateActive(state) }, null, 2)
  }

  exportCsv(): string {
    const state = this.stateSubject.value
    const caseFile = state.cases[this.activeIndex(state)]
    const rows = caseFile.features.map(feature => [
      caseFile.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      caseFile.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => caseFile.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => caseFile.paragraphs.find(item => item.id === id)?.section || id).join('；'),
      state.table.features.find(item => item.id === feature.tableFeatureId)?.code || '本地特征',
      feature.alignedRevision ?? ''
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落', '特征表条目', '对齐版本'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  // ---------- 校验 ----------

  validateActive(state = this.stateSubject.value): ValidationIssue[] {
    const caseFile = state.cases[this.activeIndex(state)]
    if (!caseFile) return []
    const issues: ValidationIssue[] = []
    for (const feature of caseFile.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, caseFile.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    for (const link of caseFile.pendingLinks) {
      issues.push({
        id: link.id, severity: 'warning', type: 'pending-link', featureId: caseFile.features.some(item => item.id === link.featureId) ? link.featureId : undefined,
        title: `${link.featureLabel} 等待按新特征表确认`,
        detail: link.reason
      })
    }
    caseFile.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
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

  // ---------- 演示：载入旧版（v1）数据并走升级 ----------

  demoLoadLegacy(): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyV1State()))
    const migrated = migrateLegacyState(legacyV1State(), this.stateSubject.value.table, tableRevision1(), new Date().toISOString())
    this.commit(state => {
      state.cases = state.cases.filter(item => item.id !== 'case-migrated')
      state.cases.unshift(migrated)
      state.activeCaseId = migrated.id
      state.view = 'case'
      state.activeTab = 'pending'
    })
  }

  resetDemo(): void {
    const fresh = seedState()
    this.past = []
    this.future = []
    this.stateSubject.next(fresh)
    this.updateHistory()
    this.saveState()
  }

  // ---------- 内部 ----------

  private commitActive(recipe: (caseFile: CaseFile, state: WorkbenchState) => void): void {
    this.commit(state => recipe(state.cases[this.activeIndex(state)], state))
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
  private saveState(): void { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateSubject.value)) }

  private loadState(): WorkbenchState {
    if (typeof localStorage === 'undefined') return seedState()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as WorkbenchState
        return parsed.schemaVersion === 2 ? { ...seedState(), ...parsed } : this.upgrade(parsed as unknown as Record<string, unknown>)
      }
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (legacy) return this.upgrade(JSON.parse(legacy) as Record<string, unknown>)
      return seedState()
    } catch {
      return seedState()
    }
  }

  /** 工作台已有数据先升级成引用特征表的结构，再参与对应 */
  private upgrade(raw: Record<string, unknown>): WorkbenchState {
    const seed = seedState()
    const migrated = migrateLegacyState(raw, seed.table, tableRevision1(), new Date().toISOString())
    migrated.name = '本机已存案件（旧版数据已升级）'
    return { ...seed, cases: [migrated, ...seed.cases.filter(item => item.id !== caseAlpha().id)], activeCaseId: migrated.id, activeTab: 'pending' }
  }
}
