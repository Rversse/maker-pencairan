import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [clockNow, setClockNow] = useState(Date.now())
  useEffect(() => { const timer = window.setInterval(() => setClockNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const canEdit = role === 'admin' || Boolean(detail && !detail.locked)

  const load = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const result = await historyRequest<{ histories: HistoryRow[] }>(token, {
        action: 'list', kitchen_id: kitchenId, date_from: selectedDate, date_to: selectedDate
      })
      setRows(result.histories)
    } catch (err) { setError(err instanceof Error ? err.message : 'Riwayat gagal dimuat.') }
    finally { setBusy(false) }
  }, [token, kitchenId, selectedDate])
  useEffect(() => { void load() }, [load])

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
    const storedOutput = event.snapshot.delta?.incremental_output
    if (typeof storedOutput === 'string') {
      if (!storedOutput.trim()) {
        setNotice(`Perubahan ${event.event_type} tersimpan. Tidak ada baris bernominal untuk disalin.`)
        setError('')
        return
      }
      try {
        await navigator.clipboard.writeText(storedOutput)
        setNotice(`Output ${event.event_type} berhasil disalin.`)
        setError('')
      } catch {
        setError('Clipboard tidak tersedia di browser ini.')
      }
      return
    }

    // Compatibility fallback for older events created before incremental_output
    // was stored. Compare complete output lines using their stable account/category
    // identity; only the amount/detail delta is copied for additive event types.
    const eventIndex = selectedEvent.findIndex(item => item.id === event.id)
    const previous = eventIndex > 0 ? selectedEvent[eventIndex - 1] : null
    const currentLines = String(event.snapshot.payload?.output ?? '').split('\n')
    const previousLines = String(previous?.snapshot.payload?.output ?? '').split('\n')
    const parseLine = (line: string) => {
      const match = /^(.*) · ([0-9.,]+)$/.exec(line)
      if (!match) return null
      const prefix = match[1]
      const identity = prefix.split(' · ')[0]
      return { identity, amount: Number(match[2].replace(/\D/g, '')) || 0, prefix }
    }
    const previousByIdentity = new Map<string, Array<NonNullable<ReturnType<typeof parseLine>>>>()
    previousLines.forEach(line => {
      const parsed = parseLine(line)
      if (!parsed) return
      const matches = previousByIdentity.get(parsed.identity) ?? []
      matches.push(parsed)
      previousByIdentity.set(parsed.identity, matches)
    })

    const changed = currentLines.flatMap(line => {
      const current = parseLine(line)
      if (!current) return []
      const matches = previousByIdentity.get(current.identity) ?? []
      const before = matches.shift()
      previousByIdentity.set(current.identity, matches)
      if (!before) return [`${current.prefix} · ${money(current.amount)}`]
      if (event.event_type === 'REVISI') {
        return before.amount !== current.amount || before.prefix !== current.prefix
          ? [`${current.prefix} · ${money(current.amount)}`]
          : []
      }
      if (event.event_type === 'KEKURANGAN' || event.event_type === 'TAMBAHAN') {
        const difference = current.amount - before.amount
        return difference > 0 ? [`${current.identity} · ${money(difference)}`] : []
      }
      return []
    })

    if (!changed.length) {
      setNotice(`Perubahan ${event.event_type} tersimpan. Tidak ada baris bernominal untuk disalin.`)
      setError('')
      return
    }
    const output = [`${event.event_type} - ${currentLines[0] ?? ''}`, ...changed].join('\n')
    try {
      await navigator.clipboard.writeText(output)
      setNotice(`Output ${event.event_type} berhasil disalin (${changed.length} baris).`)
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
  }

  async function copyActiveHistoryOutput() {
    if (activeEvent && activeEvent.event_type !== 'NORMAL') {
      await copyEventOutput(activeEvent)
      return
    }
    const output = String(activePayload?.output ?? '')
    if (!output.trim()) {
      setNotice('Snapshot ini belum memiliki output untuk disalin.')
      setError('')
      return
    }
    try {
      await navigator.clipboard.writeText(output)
      setNotice('Output snapshot awal berhasil disalin. Form Utama dan Riwayat tidak diubah.')
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
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

  const selectedEvent = useMemo(() => detail?.events ?? [], [detail])
  const activeEvent = selectedEvent.find(event => event.id === activeEventId) ?? selectedEvent[selectedEvent.length - 1] ?? null
  const activeEventIndex = activeEvent ? selectedEvent.findIndex(event => event.id === activeEvent.id) : -1
  const activePayload = activeEvent?.snapshot.payload ?? detail?.history.payload
  const previousPayload = activeEventIndex > 0 ? selectedEvent[activeEventIndex - 1]?.snapshot.payload : undefined
  const outputDiff = useMemo(() => {
    type OutputFragment = { text: string; highlighted: boolean }
    type ParsedOutputLine = {
      identity: string
      detail: string
      amount: number
      amountText: string
      hasDetail: boolean
    }
    const plain = (text: string): OutputFragment[] => text ? [{ text, highlighted: false }] : []
    const mergeFragments = (fragments: OutputFragment[]) => fragments.reduce<OutputFragment[]>((merged, fragment) => {
      if (!fragment.text) return merged
      const previous = merged[merged.length - 1]
      if (previous && previous.highlighted === fragment.highlighted) previous.text += fragment.text
      else merged.push({ ...fragment })
      return merged
    }, [])
    const changedText = (current: string, previous: string): OutputFragment[] => {
      if (!current) return []
      if (!previous) return [{ text: current, highlighted: true }]
      const tokens = current.match(/\s+|[^\s]+/g) ?? []
      const currentWordIndexes = tokens.flatMap((token, index) => /^\s+$/.test(token) ? [] : [index])
      const previousWords = previous.match(/\S+/g) ?? []
      const currentWords = currentWordIndexes.map(index => tokens[index].toLocaleLowerCase('id-ID'))
      const previousNormalized = previousWords.map(word => word.toLocaleLowerCase('id-ID'))
      const rows = currentWords.length + 1
      const columns = previousNormalized.length + 1
      const matrix = Array.from({ length: rows }, () => new Array<number>(columns).fill(0))
      for (let i = currentWords.length - 1; i >= 0; i--) {
        for (let j = previousNormalized.length - 1; j >= 0; j--) {
          matrix[i][j] = currentWords[i] === previousNormalized[j]
            ? matrix[i + 1][j + 1] + 1
            : Math.max(matrix[i + 1][j], matrix[i][j + 1])
        }
      }
      const matched = new Set<number>()
      let i = 0
      let j = 0
      while (i < currentWords.length && j < previousNormalized.length) {
        if (currentWords[i] === previousNormalized[j]) {
          matched.add(currentWordIndexes[i])
          i++
          j++
        } else if (matrix[i + 1][j] >= matrix[i][j + 1]) i++
        else j++
      }
      return mergeFragments(tokens.map((token, index) => ({
        text: token,
        highlighted: !/^\s+$/.test(token) && !matched.has(index)
      })))
    }
    const parseLine = (line: string): ParsedOutputLine | null => {
      const amountSeparator = line.lastIndexOf(' · ')
      if (amountSeparator < 0) return null
      const amountText = line.slice(amountSeparator + 3)
      if (!/^[0-9.,]+$/.test(amountText)) return null
      const body = line.slice(0, amountSeparator)
      const detailSeparator = body.indexOf(' · ')
      const identity = detailSeparator >= 0 ? body.slice(0, detailSeparator) : body
      const detail = detailSeparator >= 0 ? body.slice(detailSeparator + 3) : ''
      return {
        identity,
        detail,
        hasDetail: detailSeparator >= 0,
        amount: Number(amountText.replace(/\D/g, '')) || 0,
        amountText
      }
    }
    const currentLines = String(activeEvent?.snapshot.payload?.output ?? detail?.history.payload.output ?? '').split('\n')
    if (!activeEvent || activeEvent.event_type === 'NORMAL') {
      return { lines: currentLines.map(line => plain(line)), changedCount: 0 }
    }
    const previousLines = activeEventIndex > 0
      ? String(selectedEvent[activeEventIndex - 1]?.snapshot.payload?.output ?? '').split('\n')
      : []
    const previousParsed = previousLines.flatMap(line => {
      const parsed = parseLine(line)
      return parsed ? [parsed] : []
    })
    const usedPrevious = new Set<number>()
    let changedCount = 0
    const lines = currentLines.map(line => {
      const current = parseLine(line)
      if (!current) return plain(line)
      const candidates = previousParsed
        .map((candidate, index) => ({ candidate, index }))
        .filter(item =>
          !usedPrevious.has(item.index) &&
          item.candidate.identity.toLocaleLowerCase('id-ID') === current.identity.toLocaleLowerCase('id-ID')
        )
      const best = candidates
        .map(item => {
          const left = current.detail.toLocaleLowerCase('id-ID')
          const right = item.candidate.detail.toLocaleLowerCase('id-ID')
          const score = left === right ? 100 : left && right
            ? [...new Set(left.split(/\s+/))].filter(word => right.split(/\s+/).includes(word)).length
            : 0
          return { ...item, score }
        })
        .sort((a, b) => b.score - a.score)[0]
      if (!best) {
        changedCount++
        return [{ text: line, highlighted: true }]
      }
      usedPrevious.add(best.index)
      const before = best.candidate
      const detailChanged = current.detail !== before.detail
      const amountChanged = current.amount !== before.amount
      const amountDelta = current.amount - before.amount
      if (!detailChanged && !amountChanged) return plain(line)
      changedCount++
      const fragments: OutputFragment[] = []
      fragments.push(...plain(current.identity))
      if (current.hasDetail) {
        fragments.push(...plain(' · '))
        fragments.push(...changedText(current.detail, before.detail))
      }
      fragments.push(...plain(' · '))
      fragments.push({
        text: current.amountText,
        highlighted: activeEvent.event_type === 'REVISI' && amountChanged
      })
      if (activeEvent.event_type === 'REVISI' && amountChanged) {
        fragments.push(...plain(' (Nominal Sebelumnya: ' + money(before.amount) + ')'))
      }
      if (activeEvent.event_type === 'KEKURANGAN' && amountDelta > 0) {
        fragments.push(...plain(' (' + money(before.amount) + ' + '))
        fragments.push({ text: money(amountDelta), highlighted: true })
        fragments.push(...plain(')'))
      } else if (activeEvent.event_type === 'TAMBAHAN' && amountDelta > 0) {
        fragments.push(...plain(' (+'))
        fragments.push({ text: money(amountDelta), highlighted: true })
        fragments.push(...plain(' tambahan)'))
      }
      return mergeFragments(fragments)
    })
    return { lines, changedCount }
  }, [activeEvent, activeEventIndex, selectedEvent, detail])
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
    const hasPrevious = Boolean(previousPayload)
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

  const isSelectedEvent = (event: HistoryEvent) => activeEvent?.id === event.id

  return (
    <div className="mp-history-overlay fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm sm:p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="mp-history-title"
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void refreshDetail()}
                    title="Muat ulang data terakhir"
                    aria-label="Muat ulang data terakhir"
                    className="mp-history-icon-button grid h-9 w-9 place-items-center rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-300 transition hover:border-teal-500/60 hover:text-teal-100 disabled:opacity-40"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 7v5h-5M4 17v-5h5" />
                      <path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2" />
                    </svg>
                  </button>
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
                  {metric('Total RAB', activePayload?.totalRab, previousPayload?.totalRab)}
                  {metric('Total Ops Harian', activePayload?.totalOpsHarian, previousPayload?.totalOpsHarian)}
                  {metric('Total Keseluruhan', activePayload?.totalOverall, previousPayload?.totalOverall)}
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
                      disabled={busy || (!String(activePayload?.output ?? '').trim() && !String(activeEvent?.snapshot.delta?.incremental_output ?? '').trim())}
                      onClick={() => void copyActiveHistoryOutput()}
                      title={activeEvent && activeEvent.event_type !== 'NORMAL' ? 'Salin hanya perubahan pada riwayat ini' : 'Salin output awal'}
                      className="mp-history-secondary-button rounded-lg border border-slate-700/80 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40"
                    >
                      {activeEvent && activeEvent.event_type !== 'NORMAL' ? 'Salin Perubahan' : 'Salin Output'}
                    </button>
                  </div>
                </div>
                <div className="max-h-[34vh] min-h-[120px] overflow-auto whitespace-pre-wrap break-words px-3 py-3 text-xs leading-5 text-slate-300 sm:px-4">
                  {outputDiff.lines.map((fragments, lineIndex) => (
                    <div key={lineIndex}>{fragments.map((fragment, partIndex) =>
                      fragment.highlighted
                        ? <span key={partIndex} className="text-teal-200 underline decoration-teal-400/80 decoration-2 underline-offset-4">{fragment.text}</span>
                        : fragment.text
                    )}</div>
                  ))}
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
                    {[...selectedEvent].reverse().map(event => (
                      <div key={event.id} className={isSelectedEvent(event) ? 'mp-history-timeline-item is-active' : 'mp-history-timeline-item'}>
                        <span className="mp-history-timeline-marker" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className={event.event_type === 'NORMAL' ? 'mp-history-event-type is-normal' : 'mp-history-event-type'}>
                              {eventLabel(event.event_type)}
                            </span>
                            <span className="text-[10px] tabular-nums text-slate-500">{dateTime(event.created_at)}</span>
                          </div>
                          {event.event_type !== 'NORMAL' && <p className="mt-1 break-words text-xs text-slate-300">{event.summary || 'Perubahan tersimpan'}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" aria-pressed={isSelectedEvent(event)} onClick={() => openEventOutput(event)} className="mp-history-timeline-open rounded-md px-2.5 py-1.5 text-[10px] font-semibold">
                            {isSelectedEvent(event) ? 'Dipilih' : 'Lihat'}
                          </button>
                          {isSelectedEvent(event) && event.event_type !== 'NORMAL' && (
                            <button type="button" onClick={() => void copyEventOutput(event)} className="mp-history-timeline-copy rounded-md border border-slate-700/80 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300">
                              Salin
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
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
