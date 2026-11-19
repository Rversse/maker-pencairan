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

type AuditChange = {
  kind: 'updated' | 'added' | 'removed'
  before?: string
  after?: string
}

type HistoryTransactionShape = Record<string, unknown> & {
  rab?: Array<Record<string, unknown>>
  gas?: Array<Record<string, unknown>>
  operasional?: Array<Record<string, unknown>>
  pencairan_harian?: Array<Record<string, unknown>>
  lain_lain?: Array<Record<string, unknown>>
  arutala_lain_lain?: Array<Record<string, unknown>>
}

function transactionOf(event?: HistoryEvent | null): HistoryTransactionShape | undefined {
  const value = event?.snapshot.payload?.transaction
  return value && typeof value === 'object' ? value as HistoryTransactionShape : undefined
}

function amountOf(row?: Record<string, unknown>): number {
  return Number(String(row?.amount ?? '').replace(/[^0-9]/g, '')) || 0
}

function eventAuditChanges(event: HistoryEvent, previous?: HistoryEvent | null): AuditChange[] {
  const currentOutput = String(event.snapshot.payload?.output ?? '').split('\\n').slice(1).filter(Boolean)
  const previousOutput = String(previous?.snapshot.payload?.output ?? '').split('\\n').slice(1).filter(Boolean)
  const keyOf = (line: string) => {
    const amountSeparator = line.lastIndexOf(' · ')
    const body = amountSeparator >= 0 ? line.slice(0, amountSeparator) : line
    const detailSeparator = body.indexOf(' · ')
    return (detailSeparator >= 0 ? body.slice(0, detailSeparator) : body).trim().toLocaleLowerCase('id-ID')
  }

  const previousByKey = new Map<string, string[]>()
  previousOutput.forEach(line => {
    const key = keyOf(line)
    const queue = previousByKey.get(key) ?? []
    queue.push(line)
    previousByKey.set(key, queue)
  })

  const changes: AuditChange[] = []
  currentOutput.forEach(after => {
    const key = keyOf(after)
    const queue = previousByKey.get(key) ?? []
    const before = queue.shift()
    previousByKey.set(key, queue)
    if (!before) changes.push({ kind: 'added', after })
    else if (before !== after) changes.push({ kind: 'updated', before, after })
  })
  previousByKey.forEach(queue => queue.forEach(before => changes.push({ kind: 'removed', before })))
  return changes
}

function historyEventTags(event: HistoryEvent, previous?: HistoryEvent | null): string[] {
  if (event.event_type === 'NORMAL') return ['Pencairan Awal']
  const current = transactionOf(event)
  const before = transactionOf(previous)
  const shortageKeys = new Set(
    Array.isArray(event.snapshot.delta?.shortage_keys)
      ? (event.snapshot.delta?.shortage_keys as unknown[]).map(String)
      : []
  )
  let hasRevision = false
  let hasShortage = shortageKeys.size > 0
  let hasAddition = false

  const rabRows = current?.rab ?? []
  const previousRab = before?.rab ?? []
  const previousRabById = new Map(previousRab.map(row => [String(row.accountId ?? ''), row]))
  rabRows.forEach(row => {
    const id = String(row.accountId ?? '')
    const old = previousRabById.get(id)
    if (!old) {
      if (amountOf(row) > 0 || amountOf({ amount: row.b3Amount }) > 0) hasAddition = true
      return
    }
    if (JSON.stringify(old.amount ?? '') !== JSON.stringify(row.amount ?? '')) {
      if (shortageKeys.has('rab:' + id)) hasShortage = true
      else hasRevision = true
    }
    if (JSON.stringify(old.productTypes ?? []) !== JSON.stringify(row.productTypes ?? [])) hasRevision = true
    if (JSON.stringify(old.b3Amount ?? '') !== JSON.stringify(row.b3Amount ?? '')) {
      if (shortageKeys.has('rab_b3:' + id)) hasShortage = true
      else if (amountOf({ amount: row.b3Amount }) > 0 && amountOf({ amount: old.b3Amount }) === 0) hasAddition = true
      else hasRevision = true
    }
    if (JSON.stringify(old.b3ProductTypes ?? []) !== JSON.stringify(row.b3ProductTypes ?? [])) hasRevision = true
  })

  const sections = ['gas', 'operasional', 'pencairan_harian', 'lain_lain', 'arutala_lain_lain'] as const
  sections.forEach(section => {
    const currentRows = current?.[section] ?? []
    const previousRows = before?.[section] ?? []
    const oldById = new Map(previousRows.map(row => [String(row.id ?? ''), row]))
    const currentIds = new Set(currentRows.map(row => String(row.id ?? '')))
    currentRows.forEach(row => {
      const id = String(row.id ?? '')
      const old = oldById.get(id)
      if (!old) {
        if (amountOf(row) > 0) hasAddition = true
        return
      }
      if (JSON.stringify(old) === JSON.stringify(row)) return
      const shortageKey = section + ':' + id
      const onlyAmountChanged = Object.keys({ ...old, ...row }).every(key =>
        key === 'amount' || JSON.stringify(old[key]) === JSON.stringify(row[key])
      )
      if (shortageKeys.has(shortageKey) && onlyAmountChanged) hasShortage = true
      else hasRevision = true
    })
    previousRows.forEach(row => {
      if (!currentIds.has(String(row.id ?? '')) && amountOf(row) > 0) hasRevision = true
    })
  })

  const tags: string[] = []
  if (hasRevision) tags.push('Revisi')
  if (hasShortage) tags.push('Kekurangan')
  if (hasAddition) tags.push('Tambahan')
  if (tags.length) return tags

  if (event.event_type === 'KEKURANGAN') return ['Kekurangan']
  if (event.event_type === 'TAMBAHAN') return ['Tambahan']
  return ['Revisi']
}

function auditCopyText(event: HistoryEvent, previous?: HistoryEvent | null): string {
  if (event.event_type === 'NORMAL') return String(event.snapshot.payload?.output ?? '')
  const changes = eventAuditChanges(event, previous)
  if (!changes.length) {
    const fallback = event.snapshot.delta?.incremental_output
    return typeof fallback === 'string' ? fallback : ''
  }
  const lines = changes.flatMap(change => {
    if (change.kind === 'updated') return [
      'SEBELUMNYA: ' + (change.before ?? ''),
      'MENJADI: ' + (change.after ?? '')
    ]
    if (change.kind === 'added') return ['TAMBAHAN: ' + (change.after ?? '')]
    return ['DIHAPUS: ' + (change.before ?? '')]
  })
  return [historyEventTags(event, previous).join(' + '), ...lines].join('\\n')
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
  const activeEventOutput = String(activeEvent?.snapshot.payload?.output ?? '')
  const activeEventChanges = activeEvent && activeEvent.event_type !== 'NORMAL'
    ? eventAuditChanges(activeEvent, previousActiveEvent)
    : []
  const activeEventTags = activeEvent ? historyEventTags(activeEvent, previousActiveEvent) : []
  const activeEventCopy = activeEvent ? auditCopyText(activeEvent, previousActiveEvent) : ''
  const displayedOutput = latestView
    ? latestOutput
    : activeEvent?.event_type === 'NORMAL'
      ? activeEventOutput
      : ''
  const lockRemainingMs = Math.max(0, new Date(detail?.lock_at ?? 0).getTime() - clockNow)
  const lockCountdown = lockRemainingMs > 0
    ? `Kunci dalam ${Math.floor(lockRemainingMs / 3600000)}j ${Math.floor((lockRemainingMs % 3600000) / 60000)}m ${Math.floor((lockRemainingMs % 60000) / 1000)}d`
    : role === 'admin' ? 'Batas kunci lewat · Admin tetap dapat mengubah' : 'Sudah terkunci'
  const eventLabel = (eventType: string) => {
    if (eventType === 'NORMAL') return 'Pencairan Awal'
    if (eventType === 'REVISI') return 'Revisi'
    if (eventType === 'KEKURANGAN') return 'Kekurangan'
    if (eventType === 'TAMBAHAN') return 'Tambahan'
    return eventType
  }
  const metric = (label: string, value: unknown, previous: unknown) => {
    const currentValue = Number(value ?? 0) || 0
    const previousValue = Number(previous ?? 0) || 0
    const difference = currentValue - previousValue
    const hasPrevious = Boolean(latestPreviousPayload)
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
                      Load ke Form
                    </button>
                  )}
                  {role === 'admin' && (
                    <button type="button" disabled={busy} onClick={() => void deleteHistory()} className="mp-history-danger-button rounded-lg border border-rose-800/70 px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-40">
                      Hapus transaksi
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
                  {metric('Total RAB', latestPayload?.totalRab, latestPreviousPayload?.totalRab)}
                  {metric('Total Ops Harian', latestPayload?.totalOpsHarian, latestPreviousPayload?.totalOpsHarian)}
                  {metric('Total Keseluruhan', latestPayload?.totalOverall, latestPreviousPayload?.totalOverall)}
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
                  {latestView ? (
                    <pre className="whitespace-pre-wrap font-sans">{latestOutput || 'Belum ada output pada snapshot terakhir.'}</pre>
                  ) : activeEvent?.event_type === 'NORMAL' ? (
                    <pre className="whitespace-pre-wrap font-sans">{displayedOutput || 'Snapshot pencairan awal belum memiliki output.'}</pre>
                  ) : activeEventChanges.length ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {activeEventTags.map(tag => (
                          <span key={tag} className={`mp-history-event-tag ${tag === 'Revisi' ? 'is-revision' : tag === 'Kekurangan' ? 'is-shortage' : tag === 'Tambahan' ? 'is-addition' : ''}`}>{tag}</span>
                        ))}
                        <span className="ml-1 text-[10px] text-slate-500">{activeEvent ? dateTime(activeEvent.created_at) : ''}</span>
                      </div>
                      {activeEventChanges.map((change, index) => (
                        <div key={index} className="space-y-1 border-b border-slate-800/70 pb-2 last:border-0">
                          {change.kind === 'updated' ? (
                            <>
                              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Sebelumnya</p>
                              <p className="whitespace-pre-wrap font-sans text-slate-400">{change.before}</p>
                              <p className="pt-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-300">Menjadi</p>
                              <p className="whitespace-pre-wrap font-sans font-semibold text-teal-200">{change.after}</p>
                            </>
                          ) : change.kind === 'added' ? (
                            <>
                              <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">Ditambahkan</p>
                              <p className="whitespace-pre-wrap font-sans font-semibold text-emerald-200">{change.after}</p>
                            </>
                          ) : (
                            <>
                              <p className="text-[10px] font-bold uppercase tracking-wide text-rose-300">Dihapus</p>
                              <p className="whitespace-pre-wrap font-sans text-rose-200">{change.before}</p>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500">Tidak ada perubahan output yang bisa dibandingkan pada event ini.</p>
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
                            <button type="button" aria-pressed={isSelectedEvent(event)} onClick={() => openEventOutput(event)} className="mp-history-timeline-open rounded-md px-2.5 py-1.5 text-[10px] font-semibold">
                              {isSelectedEvent(event) ? 'Pilih' : 'Lihat'}
                            </button>
                            {isSelectedEvent(event) && event.event_type !== 'NORMAL' && (
                              <button type="button" onClick={() => void copyEventOutput(event)} className="mp-history-timeline-copy rounded-md border border-slate-700/80 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300">
                                Salin
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
