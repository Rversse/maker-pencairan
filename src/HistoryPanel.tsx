import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabase'

type HistoryRow = {
  id: string
  kitchen_id: string
  title: string | null
  status: string
  transaction_date: string
  version: number
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
  currentSnapshot: Record<string, unknown>
  onClose: () => void
}
const EVENT_TYPES = ['REVISI', 'KEKURANGAN', 'TAMBAHAN'] as const
const money = (value: unknown) => new Intl.NumberFormat('id-ID').format(Number(value) || 0)
const dateTime = (value: string) => new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })

async function historyRequest<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('maker-history', {
    body,
    headers: { Authorization: `Bearer ${token}` }
  })
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'HISTORY gagal dimuat.')
  return data as T
}
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const delta: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) delta[key] = after[key] ?? null
  }
  return delta
}

export default function HistoryPanel({ token, role, kitchenId, kitchenName, transactionDate, currentSnapshot, onClose }: Props) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [detail, setDetail] = useState<HistoryDetail | null>(null)
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>('REVISI')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canEdit = role === 'admin' || Boolean(detail && !detail.locked)

  const load = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const result = await historyRequest<{ histories: HistoryRow[] }>(token, {
        action: 'list', kitchen_id: kitchenId, date_from: transactionDate, date_to: transactionDate
      })
      setRows(result.histories)
    } catch (err) { setError(err instanceof Error ? err.message : 'HISTORY gagal dimuat.') }
    finally { setBusy(false) }
  }, [token, kitchenId, transactionDate])
  useEffect(() => { void load() }, [load])

  async function openDetail(id: string) {
    setBusy(true); setError('')
    try {
      const result = await historyRequest<HistoryDetail & { ok: boolean }>(token, { action: 'get', draft_id: id })
      setDetail(result)
    } catch (err) { setError(err instanceof Error ? err.message : 'Detail HISTORY gagal dimuat.') }
    finally { setBusy(false) }
  }
  async function createHistory() {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await historyRequest<{ history: HistoryRow }>(token, {
        action: 'create', kitchen_id: kitchenId, transaction_date: transactionDate,
        title: `Pencairan ${kitchenName} - ${transactionDate}`, payload: currentSnapshot
      })
      setNotice('HISTORY awal berhasil disimpan.')
      await load()
      await openDetail(result.history.id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan HISTORY.') }
    finally { setBusy(false) }
  }
  async function saveChange() {
    if (!detail) return
    const before = detail.history.payload
    const delta = changedFields(before, currentSnapshot)
    if (!Object.keys(delta).length) { setError('Tidak ada perubahan dari snapshot terakhir.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await historyRequest(token, {
        action: 'change', draft_id: detail.history.id, expected_version: detail.history.version,
        event_type: eventType, summary, delta, snapshot: currentSnapshot
      })
      setNotice(`${eventType} berhasil disimpan sebagai versi berikutnya.`)
      setSummary('')
      await openDetail(detail.history.id)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Gagal menyimpan perubahan.') }
    finally { setBusy(false) }
  }
  const currentOutput = String(currentSnapshot.output ?? '')
  const selectedEvent = useMemo(() => detail?.events ?? [], [detail])

  return <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-3 pt-8 sm:p-6">
    <section className="w-full max-w-4xl rounded-2xl border border-slate-700 bg-slate-950 p-4 shadow-2xl sm:p-5">
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div><h2 className="text-lg font-bold">HISTORY Pencairan</h2><p className="mt-1 text-xs text-slate-400">{kitchenName} · {transactionDate}</p></div>
        <button onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Tutup</button>
      </header>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-xs text-emerald-200">{notice}</p>}
      {!detail ? <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Daftar pencairan tanggal ini</h3>
          {!rows.length && <button disabled={busy || !kitchenId} onClick={() => void createHistory()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold disabled:opacity-40">Simpan HISTORY awal</button>}
        </div>
        {busy && <p className="text-xs text-slate-400">Memuat...</p>}
        {!rows.length && !busy && <p className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-xs text-slate-400">Belum ada HISTORY untuk dapur dan tanggal ini.</p>}
        {rows.map(row => <button key={row.id} onClick={() => void openDetail(row.id)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-left hover:border-emerald-700">
          <span><span className="block text-sm font-semibold">{row.title || 'Pencairan'}</span><span className="mt-1 block text-[11px] text-slate-400">Versi {row.version} · Dibuat {dateTime(row.created_at)}</span></span>
          <span className="text-xs text-emerald-300">Buka</span>
        </button>)}
      </div> : <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{detail.history.title || 'Pencairan'}</h3><p className="mt-1 text-[11px] text-slate-400">Versi {detail.history.version} · {detail.locked && role !== 'admin' ? 'Terkunci' : 'Dapat diperbarui'}</p></div>
          <button onClick={() => { setDetail(null); void load() }} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Kembali ke daftar</button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total RAB</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalRab)}</p></div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total Ops Harian</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalOpsHarian)}</p></div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total Keseluruhan</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalOverall)}</p></div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-3"><h4 className="mb-2 text-xs font-semibold">Output snapshot</h4><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">{String(detail.history.payload.output ?? '')}</pre></div>
        <div><h4 className="mb-2 text-xs font-semibold">Riwayat versi</h4><div className="space-y-2">{selectedEvent.map(event => <div key={event.id} className="rounded-lg border border-slate-800 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-xs font-semibold text-emerald-300">{event.event_type}</span><span className="text-[10px] text-slate-500">{dateTime(event.created_at)}</span></div><p className="mt-1 text-xs text-slate-300">{event.summary || 'Perubahan tersimpan'}</p></div>)}</div></div>
        {canEdit && <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3"><h4 className="text-xs font-semibold">Simpan perubahan incremental</h4><div className="mt-2 flex flex-wrap gap-2"><select value={eventType} onChange={e => setEventType(e.target.value as typeof eventType)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs">{EVENT_TYPES.map(type => <option key={type}>{type}</option>)}</select><input value={summary} onChange={e => setSummary(e.target.value)} placeholder="Catatan perubahan (opsional)" className="min-w-[180px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs" /><button disabled={busy} onClick={() => void saveChange()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold disabled:opacity-40">Simpan versi {detail.history.version + 1}</button></div><p className="mt-2 text-[10px] text-slate-500">Hanya field yang berubah dicatat sebagai delta. Batas kunci: {dateTime(detail.lock_at)}.</p></div>}
        {!canEdit && <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-xs text-amber-200">HISTORY terkunci. Hanya Admin yang dapat mengubahnya.</p>}
      </div>}
    </section>
  </div>
}
