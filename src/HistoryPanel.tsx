import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

type HistoryRow = {
  id: string
  kitchen_id: string
  title: string | null
  status: string
  transaction_date: string
  version: number
  payload?: Record<string, unknown>
  created_at: string
  updated_at: string
}
type HistoryEvent = {
  id: string
  event_type: string
  summary: string | null
  snapshot: { version?: number; payload?: Record<string, unknown>; delta?: Record<string, unknown> }
  created_at: string
}
type HistoryDetail = {
  history: HistoryRow & { payload: Record<string, unknown> }
  events: HistoryEvent[]
  locked: boolean
  lock_at: string
}

const EMPTY_HISTORY_EVENTS: HistoryEvent[] = []
type Props = {
  token: string
  role: 'admin' | 'accountant'
  kitchenId: string
  kitchenName: string
  transactionDate: string
  onLoadSnapshot: (payload: Record<string, unknown>) => void
  onRefreshSnapshot: (payload: Record<string, unknown>) => void
  onStartChange: (payload: Record<string, unknown>) => void
  onClose: () => void
}
const money = (value: unknown) => new Intl.NumberFormat('id-ID').format(Number(value) || 0)
const formatDate = (value: string) => {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) return value
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  return `${match[3]}-${months[Number(match[2]) - 1] ?? match[2]}-${match[1]}`
}
const dateTime = (value: string) => {
  const date = new Date(value)
  return `${formatDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)} · ${date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`
}

type AuditRowKind = 'revision' | 'shortage' | 'addition' | 'removal'
type StoredAuditRow = {
  key?: string
  kind: AuditRowKind
  before: string | null
  after: string | null
  beforeAmount?: number
  afterAmount?: number
  deltaAmount?: number
}
type AuditDisplayLine = {
  text: string
  kind?: AuditRowKind
  suffix?: string
}

function splitOutputLine(line: string) {
  const amountSeparator = line.lastIndexOf(' · ')
  const body = amountSeparator >= 0 ? line.slice(0, amountSeparator) : line
  const amount = amountSeparator >= 0 ? line.slice(amountSeparator + 3) : ''
  const detailSeparator = body.indexOf(' · ')
  const identity = detailSeparator >= 0 ? body.slice(0, detailSeparator) : body
  const detail = detailSeparator >= 0 ? body.slice(detailSeparator + 3) : ''
  return { identity: identity.trim().toLocaleLowerCase('id-ID'), prefix: identity, detail, amount }
}

function legacyAuditRows(event: HistoryEvent, previous?: HistoryEvent | null): StoredAuditRow[] {
  const currentLines = String(event.snapshot.payload?.output ?? '').split('\n').slice(1).filter(Boolean)
  const previousLines = String(previous?.snapshot.payload?.output ?? '').split('\n').slice(1).filter(Boolean)
  const previousByIdentity = new Map<string, string[]>()
  previousLines.forEach(line => {
    const identity = splitOutputLine(line).identity
    const queue = previousByIdentity.get(identity) ?? []
    queue.push(line)
    previousByIdentity.set(identity, queue)
  })

  const shortageKeys = Array.isArray(event.snapshot.delta?.shortage_keys)
    ? event.snapshot.delta.shortage_keys as unknown[]
    : []
  const changed: StoredAuditRow[] = []
  currentLines.forEach(after => {
    const parts = splitOutputLine(after)
    const queue = previousByIdentity.get(parts.identity) ?? []
    const exactIndex = queue.findIndex(before => splitOutputLine(before).detail === parts.detail)
    const matchIndex = exactIndex >= 0 ? exactIndex : queue.length ? 0 : -1
    const before = matchIndex >= 0 ? queue.splice(matchIndex, 1)[0] : undefined
    previousByIdentity.set(parts.identity, queue)
    if (!before) {
      changed.push({ kind: 'addition', before: null, after })
    } else if (before !== after) {
      changed.push({
        kind: shortageKeys.length ? 'shortage' : 'revision',
        before,
        after,
        beforeAmount: Number(splitOutputLine(before).amount.replace(/\D/g, '')) || 0,
        afterAmount: Number(parts.amount.replace(/\D/g, '')) || 0
      })
    }
  })
  previousByIdentity.forEach(queue => queue.forEach(before => changed.push({ kind: 'removal', before, after: null })))
  return changed
}

function auditRowsForEvent(event: HistoryEvent, previous?: HistoryEvent | null): StoredAuditRow[] {
  const stored = event.snapshot.delta?.audit_rows
  if (Array.isArray(stored)) return stored as StoredAuditRow[]
  return legacyAuditRows(event, previous)
}

function historyEventTags(event: HistoryEvent, previous?: HistoryEvent | null): string[] {
  if (event.event_type === 'NORMAL') return ['Pencairan Awal']
  const rows = auditRowsForEvent(event, previous)
  const hasRevision = rows.some(row => row.kind === 'revision' || row.kind === 'removal')
  const hasShortage = rows.some(row => row.kind === 'shortage')
  const hasAddition = rows.some(row => row.kind === 'addition')
  const tags: string[] = []
  if (hasRevision) tags.push('Revisi')
  if (hasShortage) tags.push('Kekurangan')
  if (hasAddition) tags.push('Tambahan')
  return tags.length ? tags : [event.event_type === 'KEKURANGAN' ? 'Kekurangan' : event.event_type === 'TAMBAHAN' ? 'Tambahan' : 'Revisi']
}

function auditSuffix(row: StoredAuditRow): string {
  if (!row.before || !row.after) return ''
  const before = splitOutputLine(row.before)
  const after = splitOutputLine(row.after)
  const beforeAmount = row.beforeAmount ?? (Number(before.amount.replace(/\D/g, '')) || 0)
  const afterAmount = row.afterAmount ?? (Number(after.amount.replace(/\D/g, '')) || 0)
  const deltaAmount = row.deltaAmount ?? (afterAmount - beforeAmount)

  if (row.kind === 'shortage' && deltaAmount > 0) {
    return `(${money(beforeAmount)} + ${money(deltaAmount)})`
  }
  if (beforeAmount !== afterAmount) {
    if (before.prefix === after.prefix && before.detail === after.detail) {
      return `(${money(beforeAmount)} → ${money(afterAmount)})`
    }
    const beforeDescription = [before.detail, money(beforeAmount)].filter(Boolean).join(' · ')
    const afterDescription = [after.detail, money(afterAmount)].filter(Boolean).join(' · ')
    return `(${beforeDescription || row.before} → ${afterDescription || row.after})`
  }
  if (before.detail !== after.detail) return `(${before.detail || before.prefix} → ${after.detail || after.prefix})`
  return `(${before.prefix} → ${after.prefix})`
}

function auditedEventLines(event: HistoryEvent, previous?: HistoryEvent | null): AuditDisplayLine[] {
  const output = String(event.snapshot.payload?.output ?? '')
  const lines = output ? output.split('\n') : []
  if (event.event_type === 'NORMAL' || !previous) return lines.map(text => ({ text }))

  const auditRows = auditRowsForEvent(event, previous)
  const rowsByAfter = new Map<string, StoredAuditRow[]>()
  auditRows.forEach(row => {
    if (!row.after) return
    const queue = rowsByAfter.get(row.after) ?? []
    queue.push(row)
    rowsByAfter.set(row.after, queue)
  })

  const displayLines = lines.map((text, index) => {
    if (index === 0) return { text }
    const queue = rowsByAfter.get(text) ?? []
    const row = queue.shift()
    rowsByAfter.set(text, queue)
    if (!row) return { text }
    return {
      text,
      kind: row.kind,
      suffix: auditSuffix(row)
    }
  })
  auditRows.filter(row => row.kind === 'removal' && row.before).forEach(row => {
    displayLines.push({ text: `Dihapus: ${row.before}`, kind: 'removal' })
  })
  return displayLines
}

function auditCopyText(event: HistoryEvent, previous?: HistoryEvent | null): string {
  return auditedEventLines(event, previous).map(line => line.suffix ? `${line.text} ${line.suffix}` : line.text).join('\n')
}

async function historyRequest<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('maker-history', {
    body,
    headers: { Authorization: `Bearer ${token}` }
  })
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Riwayat gagal dimuat.')
  return data as T
}
export default function HistoryPanel({ token, role, kitchenId, kitchenName, transactionDate, onLoadSnapshot, onRefreshSnapshot, onStartChange, onClose }: Props) {
  const [selectedDate, setSelectedDate] = useState(transactionDate)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [detail, setDetail] = useState<HistoryDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  const [clockNow, setClockNow] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])
  useEffect(() => {
    const updateClock = () => setClockNow(Date.now())
    const frame = window.requestAnimationFrame(updateClock)
    const timer = window.setInterval(updateClock, 1000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [])
  const canEdit = role === 'admin' || Boolean(detail && !detail.locked)

  const load = useCallback(async () => {
    await Promise.resolve()
    setBusy(true); setError('')
    try {
      const result = await historyRequest<{ histories: HistoryRow[] }>(token, {
        action: 'list', kitchen_id: kitchenId, date_from: selectedDate, date_to: selectedDate
      })
      setRows(result.histories)
    } catch (err) { setError(err instanceof Error ? err.message : 'Riwayat gagal dimuat.') }
    finally { setBusy(false) }
  }, [token, kitchenId, selectedDate])
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function refreshDetail() {
    if (!detail) return
    const confirmed = window.confirm('Muat ulang data terakhir? Perubahan Form Utama yang belum disimpan akan ditimpa.')
    if (!confirmed) return
    setBusy(true); setError('')
    try {
      const result = await historyRequest<HistoryDetail & { ok: boolean }>(token, { action: 'get', draft_id: detail.history.id })
      setDetail(result)
      setActiveEventId(null)
      onRefreshSnapshot(result.history.payload)
      await load()
      setNotice('Data riwayat terbaru berhasil dimuat ulang.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Riwayat gagal diperbarui.') }
    finally { setBusy(false) }
  }

  async function openDetail(id: string) {
    setBusy(true); setError('')
    try {
      const result = await historyRequest<HistoryDetail & { ok: boolean }>(token, { action: 'get', draft_id: id })
      setDetail(result)
      setActiveEventId(null)
    } catch (err) { setError(err instanceof Error ? err.message : 'Detail Riwayat gagal dimuat.') }
    finally { setBusy(false) }
  }
  function openEventOutput(event: HistoryEvent) {
    setActiveEventId(event.id)
    setError('')
    setNotice('')
  }
  async function copyEventOutput(event: HistoryEvent) {
    const eventIndex = selectedEvent.findIndex(item => item.id === event.id)
    const previous = eventIndex > 0 ? selectedEvent[eventIndex - 1] : null
    const output = auditCopyText(event, previous)
    if (!output.trim()) {
      setNotice(`Tidak ada perubahan output yang dapat disalin untuk aktivitas ${event.event_type}.`)
      setError('')
      return
    }
    try {
      await navigator.clipboard.writeText(output)
      setNotice(event.event_type === 'NORMAL' ? 'Output pencairan awal berhasil disalin.' : 'Audit perubahan berhasil disalin.')
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
  }

  async function copyLatestHistoryOutput() {
    const output = String(detail?.history.payload?.output ?? '')
    if (!output.trim()) {
      setNotice('Snapshot terbaru belum memiliki output untuk disalin.')
      setError('')
      return
    }
    try {
      await navigator.clipboard.writeText(output)
      setNotice('Output terbaru berhasil disalin. Seluruh perubahan tersimpan sudah disertakan.')
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
  }

  async function copyCurrentOutput() {
    if (latestView) {
      await copyLatestHistoryOutput()
      return
    }
    if (activeEvent) await copyEventOutput(activeEvent)
  }

  async function deleteHistory() {
    if (!detail || role !== "admin") return
    const confirmed = window.confirm("Hapus transaksi Riwayat ini? Transaksi tidak akan tampil lagi di daftar. Tindakan ini berlaku untuk status terkunci maupun belum terkunci.")
    if (!confirmed) return
    setBusy(true); setError(''); setNotice('')
    try {
      await historyRequest(token, { action: 'delete', draft_id: detail.history.id })
      setDetail(null)
      setNotice('Transaksi berhasil dihapus dari Riwayat.')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Transaksi gagal dihapus.') }
    finally { setBusy(false) }
  }

  const selectedEvent = detail?.events ?? EMPTY_HISTORY_EVENTS
  const latestEvent = selectedEvent[selectedEvent.length - 1] ?? null
  const activeEvent = activeEventId
    ? selectedEvent.find(event => event.id === activeEventId) ?? null
    : null
  const activeEventIndex = activeEvent ? selectedEvent.findIndex(event => event.id === activeEvent.id) : -1
  const previousActiveEvent = activeEventIndex > 0 ? selectedEvent[activeEventIndex - 1] : null
  const latestPayload = detail?.history.payload ?? latestEvent?.snapshot.payload
  const latestPreviousPayload = selectedEvent.length > 1
    ? selectedEvent[selectedEvent.length - 2]?.snapshot.payload
    : undefined
  const latestOutput = String(latestPayload?.output ?? '')
  const latestView = activeEventId === null
  const viewPayload = latestView ? latestPayload : activeEvent?.snapshot.payload ?? latestPayload
  const viewPreviousPayload = latestView ? latestPreviousPayload : previousActiveEvent?.snapshot.payload
  const activeEventTags = activeEvent ? historyEventTags(activeEvent, previousActiveEvent) : []
  const activeEventLines = activeEvent ? auditedEventLines(activeEvent, previousActiveEvent) : []
  const outputDisplayLines: AuditDisplayLine[] = latestView ? latestOutput.split('\n').map(text => ({ text })) : activeEventLines
  const activeEventCopy = activeEvent ? auditCopyText(activeEvent, previousActiveEvent) : ''
  const lockRemainingMs = Math.max(0, new Date(detail?.lock_at ?? 0).getTime() - clockNow)
  const lockCountdown = lockRemainingMs > 0
    ? `Kunci dalam ${Math.floor(lockRemainingMs / 3600000)}j ${Math.floor((lockRemainingMs % 3600000) / 60000)}m ${Math.floor((lockRemainingMs % 60000) / 1000)}d`
    : role === 'admin' ? 'Batas kunci lewat · Admin tetap dapat mengubah' : 'Sudah terkunci'
  const metric = (label: string, value: unknown, previous: unknown) => {
    const currentValue = Number(value ?? 0) || 0
    const previousValue = Number(previous ?? 0) || 0
    const difference = currentValue - previousValue
    const hasPrevious = Boolean(viewPreviousPayload)
    const indicatorClass = difference > 0 ? 'text-emerald-300' : difference < 0 ? 'text-rose-300' : 'text-slate-500'
    const indicator = !hasPrevious || difference === 0 ? '' : difference > 0 ? `↑ +Rp ${money(difference)}` : `↓ -Rp ${money(Math.abs(difference))}`
    return (
      <div className="mp-history-metric min-w-0 rounded-xl px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400">{label}</p>
        <p className="mt-1 break-words text-lg font-bold tabular-nums text-slate-50">Rp {money(currentValue)}</p>
        {indicator && <p className={`mt-1 text-[10px] font-semibold tabular-nums ${indicatorClass}`}>{indicator}</p>}
      </div>
    )
  }

  const isSelectedEvent = (event: HistoryEvent) => activeEventId === event.id

  return (
    <div className="mp-history-overlay fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm sm:p-5">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mp-history-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
          )).filter(element => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true')
          if (!focusable.length) {
            event.preventDefault()
            event.currentTarget.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
            event.preventDefault()
            first.focus()
          }
        }}
        className="mp-history-dialog flex min-w-0 max-h-[min(94dvh,900px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-[#0b1422] shadow-2xl shadow-black/50"
      >
        <header className="mp-history-header flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800/90 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 id="mp-history-title" className="text-base font-bold tracking-tight text-slate-50 sm:text-lg">Riwayat Pencairan</h2>
            <p className="mt-0.5 truncate text-xs text-slate-400">{kitchenName}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!detail && (
              <label className="mp-history-date relative flex h-9 min-w-[168px] items-center gap-2 overflow-hidden rounded-lg border border-slate-700/80 bg-slate-900/70 px-2.5">
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-teal-300" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
                  <path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17" />
                </svg>
                <span aria-hidden="true" className="min-w-[126px] text-xs font-semibold tabular-nums text-slate-100">{formatDate(selectedDate)}</span>
                <input
                  type="date"
                  aria-label="Pilih tanggal riwayat"
                  value={selectedDate}
                  onClick={event => event.currentTarget.showPicker?.()}
                  onChange={event => setSelectedDate(event.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0 [color-scheme:dark]"
                />
              </label>
            )}
            <button
              type="button"
              onClick={onClose}
              title="Tutup riwayat"
              aria-label="Tutup riwayat"
              className="mp-history-icon-button grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-300 transition hover:border-teal-500/60 hover:text-white"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="m18 6-12 12M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {(error || notice) && (
          <div className="mp-history-messages shrink-0 space-y-2 px-4 pt-3 sm:px-5">
            {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/25 px-3 py-2.5 text-xs text-rose-200">{error}</p>}
            {notice && <p role="status" className="rounded-lg border border-teal-800/60 bg-teal-950/20 px-3 py-2.5 text-xs text-teal-100">{notice}</p>}
          </div>
        )}

        <div className="mp-history-body min-w-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {!detail ? (
            <div className="space-y-2">

              {busy && (
                <div className="flex items-center gap-2 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-3 text-xs text-slate-400">
                  <span className="mp-history-spinner h-3.5 w-3.5 rounded-full border-2 border-slate-600 border-t-teal-300" />
                  Memuat riwayat...
                </div>
              )}

              {!rows.length && !busy && (
                <div className="rounded-xl border border-dashed border-slate-700/80 bg-slate-900/25 px-4 py-10 text-center">
                  <svg viewBox="0 0 24 24" className="mx-auto h-8 w-8 text-slate-600" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <rect x="4" y="4.5" width="16" height="16" rx="2" />
                    <path d="M8 3v3M16 3v3M4 9h16M8 13h3M8 16.5h6" />
                  </svg>
                  <p className="mt-3 text-sm font-semibold text-slate-300">Belum ada pencairan</p>
                  <p className="mt-1 text-xs text-slate-500">Tidak ada transaksi untuk tanggal ini.</p>
                </div>
              )}

              <div className="space-y-2">
                {rows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void openDetail(row.id)}
                    className="mp-history-list-item group flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/90 bg-slate-900/55 px-3.5 py-3 text-left transition duration-150 hover:border-teal-600/50 hover:bg-slate-900/90 disabled:cursor-wait disabled:opacity-60 sm:px-4"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="mp-history-date-icon grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-700/70 bg-slate-800/70 text-teal-300">
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
                          <path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17" />
                        </svg>
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-100">{formatDate(row.transaction_date)}</span>
                      </span>
                    </span>
                    <span className="mp-history-list-totals grid w-full grid-cols-3 gap-2 border-t border-slate-800/70 pt-2 text-left sm:w-auto sm:min-w-[330px] sm:border-0 sm:pt-0">
                      <span className="min-w-0">
                        <span className="block text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500">RAB</span>
                        <span className="mt-0.5 block truncate text-right text-xs font-semibold tabular-nums text-slate-200">Rp {money(row.payload?.totalRab)}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500">Ops harian</span>
                        <span className="mt-0.5 block truncate text-right text-xs font-semibold tabular-nums text-slate-200">Rp {money(row.payload?.totalOpsHarian)}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500">Total</span>
                        <span className="mt-0.5 block truncate text-right text-xs font-bold tabular-nums text-teal-200">Rp {money(row.payload?.totalOverall)}</span>
                      </span>
                    </span>
                    <svg viewBox="0 0 24 24" className="hidden h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-teal-300 sm:block" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 sm:space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-bold text-slate-100">{formatDate(detail.history.transaction_date)}</h3>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className={detail.locked ? 'mp-history-status mp-history-status--locked' : 'mp-history-status mp-history-status--editable'}>
                      {detail.locked ? 'Terkunci' : 'Edit'}
                    </span>
                    <span className="text-[10px] text-slate-500">{lockCountdown}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canEdit && role === 'admin' && (
                    <button type="button" disabled={busy} onClick={() => onLoadSnapshot(detail.history.payload)} className="mp-history-secondary-button rounded-lg border border-slate-700/80 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">
                      Load
                    </button>
                  )}
                  {role === 'admin' && (
                    <button type="button" disabled={busy} onClick={() => void deleteHistory()} className="mp-history-danger-button rounded-lg border border-rose-800/70 px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-40">
                      Hapus
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setDetail(null); void load() }}
                    title="Kembali ke daftar riwayat"
                    aria-label="Kembali ke daftar riwayat"
                    className="mp-history-icon-button grid h-9 w-9 place-items-center rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-300 transition hover:border-teal-500/60 hover:text-white"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m15 18-6-6 6-6M9 12h11" />
                    </svg>
                  </button>
                </div>
              </div>

              <section className="mp-history-summary rounded-xl border border-slate-800/80 bg-slate-900/45 p-3 sm:p-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {metric('Total RAB', viewPayload?.totalRab, viewPreviousPayload?.totalRab)}
                  {metric('Total Ops Harian', viewPayload?.totalOpsHarian, viewPreviousPayload?.totalOpsHarian)}
                  {metric('Total Keseluruhan', viewPayload?.totalOverall, viewPreviousPayload?.totalOverall)}
                </div>
              </section>

              <section className="mp-history-output overflow-hidden rounded-xl border border-slate-800/80 bg-slate-900/55">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2.5 sm:px-4">
                  <h4 className="text-sm font-semibold text-slate-100">Output</h4>
                  <div className="flex flex-wrap items-center gap-2">
                    {canEdit && (
                      <button type="button" disabled={busy} onClick={() => onStartChange(detail.history.payload)} className="mp-history-primary-button rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                        Revisi
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || (latestView ? !latestOutput.trim() : !activeEventCopy.trim())}
                      onClick={() => void copyCurrentOutput()}
                      title={latestView ? 'Salin output lengkap dari snapshot terbaru' : 'Salin audit perubahan pada event terpilih'}
                      className="mp-history-secondary-button rounded-lg border border-slate-700/80 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40"
                    >
                      Salin
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void refreshDetail()}
                      title="Reset ke output terbaru dan muat ulang snapshot"
                      aria-label="Reset ke output terbaru"
                      className="mp-history-icon-button grid h-9 w-9 place-items-center rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-300 transition hover:border-teal-500/60 hover:text-teal-100 disabled:opacity-40"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 7v5h-5M4 17v-5h5" />
                        <path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="max-h-[34vh] min-h-[120px] overflow-auto break-words px-3 py-3 text-xs leading-5 text-slate-300 sm:px-4">
                  {latestView && !latestOutput.trim() ? (
                    <p className="text-slate-500">Belum ada output pada snapshot terbaru.</p>
                  ) : !outputDisplayLines.length ? (
                    <p className="text-slate-500">Snapshot event ini belum memiliki output.</p>
                  ) : (
                    <div className="whitespace-pre-wrap font-sans">
                      {outputDisplayLines.map((line, index) => {
                        const highlightClass = line.kind === 'shortage'
                          ? 'text-amber-200 underline decoration-amber-400/80 decoration-2 underline-offset-4'
                          : line.kind === 'addition'
                            ? 'text-emerald-200 underline decoration-emerald-400/80 decoration-2 underline-offset-4'
                            : line.kind === 'removal'
                              ? 'text-rose-200 line-through decoration-rose-400/80'
                              : 'text-teal-200 underline decoration-teal-400/80 decoration-2 underline-offset-4'
                        return (
                          <div key={index} className={line.kind ? 'py-0.5' : ''}>
                            <span className={line.kind ? highlightClass : ''}>{line.text}</span>
                            {line.suffix && <span className={line.kind === 'shortage' ? 'ml-1 text-amber-300' : 'ml-1 text-teal-300'}>{line.suffix}</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </section>

              <section className="mp-history-timeline">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-slate-100">Timeline</h4>
                  <span className="text-[10px] tabular-nums text-slate-500">{selectedEvent.length} aktivitas</span>
                </div>
                {!selectedEvent.length ? (
                  <p className="rounded-lg border border-dashed border-slate-700/80 px-3 py-4 text-xs text-slate-500">Belum ada aktivitas.</p>
                ) : (
                  <div className="space-y-2">
                    {[...selectedEvent].reverse().map(event => {
                      const eventIndex = selectedEvent.findIndex(item => item.id === event.id)
                      const previous = eventIndex > 0 ? selectedEvent[eventIndex - 1] : null
                      const tags = historyEventTags(event, previous)
                      return (
                        <div key={event.id} className={isSelectedEvent(event) ? 'mp-history-timeline-item is-active' : 'mp-history-timeline-item'}>
                          <span className="mp-history-timeline-marker" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {tags.map(tag => (
                                <span key={tag} className={`mp-history-event-tag ${tag === 'Pencairan Awal' ? 'is-normal' : tag === 'Revisi' ? 'is-revision' : tag === 'Kekurangan' ? 'is-shortage' : 'is-addition'}`}>{tag}</span>
                              ))}
                              <span className="text-[10px] tabular-nums text-slate-500">{dateTime(event.created_at)}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {isSelectedEvent(event) ? (
                              <button type="button" onClick={() => void copyEventOutput(event)} className="mp-history-timeline-copy rounded-md border border-slate-700/80 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300">
                                Salin
                              </button>
                            ) : (
                              <button type="button" onClick={() => openEventOutput(event)} className="mp-history-timeline-open rounded-md px-2.5 py-1.5 text-[10px] font-semibold">
                                Pilih
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {!canEdit && (
                <p className="rounded-lg border border-amber-800/50 bg-amber-950/15 px-3 py-2.5 text-xs text-amber-200">
                  Riwayat terkunci. Hanya Admin yang dapat mengubahnya.
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
