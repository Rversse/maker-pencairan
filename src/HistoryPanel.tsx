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
  rabLabels: Record<string, string>
  onLoadSnapshot: (payload: Record<string, unknown>) => void
  onStartChange: (payload: Record<string, unknown>, eventType: 'REVISI' | 'KEKURANGAN' | 'TAMBAHAN', selectedKeys: string[]) => void
  onClose: () => void
}
const money = (value: unknown) => new Intl.NumberFormat('id-ID').format(Number(value) || 0)
const formatDate = (value: string) => {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(value)
  if (!match) return value
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  return `${match[3]}-${months[Number(match[2]) - 1] ?? match[2]}-${match[1]}`
}
const formatTitle = (value: string | null) => value?.replace(/\\d{4}-\\d{2}-\\d{2}/g, date => formatDate(date)) ?? ''
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
export default function HistoryPanel({ token, role, kitchenId, kitchenName, transactionDate, rabLabels, onLoadSnapshot, onStartChange, onClose }: Props) {
  const [selectedDate, setSelectedDate] = useState(transactionDate)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [detail, setDetail] = useState<HistoryDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [changeType, setChangeType] = useState<'REVISI' | 'KEKURANGAN' | 'TAMBAHAN'>('REVISI')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
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

  async function openDetail(id: string) {
    setBusy(true); setError('')
    try {
      const result = await historyRequest<HistoryDetail & { ok: boolean }>(token, { action: 'get', draft_id: id })
      setDetail(result)
    } catch (err) { setError(err instanceof Error ? err.message : 'Detail Riwayat gagal dimuat.') }
    finally { setBusy(false) }
  }
  async function copyEventOutput(event: HistoryEvent) {
    const text = event.event_type === 'NORMAL'
      ? String(event.snapshot.payload?.output ?? '')
      : String(event.snapshot.delta?.incremental_output ?? '')
    if (!text) { setError('Tidak ada baris output baru pada perubahan ini.'); return }
    try { await navigator.clipboard.writeText(text); setNotice('Output incremental berhasil disalin.') }
    catch { setError('Clipboard tidak tersedia di browser ini.') }
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
  const sourceTransaction = detail?.history.payload.transaction as Record<string, unknown> | undefined
  const selectableEntries = useMemo(() => {
    if (!sourceTransaction) return []
    const entries: Array<{ key: string; label: string; amount: string }> = []
    const rab = Array.isArray(sourceTransaction.rab) ? sourceTransaction.rab as Array<Record<string, unknown>> : []
    rab.forEach(entry => entries.push({
      key: 'rab:' + String(entry.accountId),
      label: 'RAB · ' + (rabLabels[String(entry.accountId)] ?? String(entry.accountId)),
      amount: money(String(entry.amount ?? '').replace(/\\D/g, ''))
    }))
    const sections = [
      ['gas', 'GAS'],
      ['operasional', 'Ops Harian'],
      ['pencairan_harian', 'Pencairan harian'],
      ['lain_lain', 'Lain-lain'],
      ['arutala_lain_lain', 'Arutala']
    ] as const
    sections.forEach(([field, title]) => {
      const rows = Array.isArray(sourceTransaction[field]) ? sourceTransaction[field] as Array<Record<string, unknown>> : []
      rows.forEach(entry => {
        const detailLabel = field === 'pencairan_harian'
          ? (Array.isArray(entry.kinds) ? entry.kinds.join(' + ') : String(entry.category ?? 'Pencairan'))
          : String(entry.need ?? entry.accountId ?? title)
        entries.push({
          key: field + ':' + String(entry.id),
          label: title + ' · ' + detailLabel,
          amount: money(String(entry.amount ?? '').replace(/\\D/g, ''))
        })
      })
    })
    return entries
  }, [sourceTransaction])

  return <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-3 pt-8 sm:p-6">
    <section className="w-full max-w-4xl rounded-2xl border border-slate-700 bg-slate-950 p-4 shadow-2xl sm:p-5">
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div><h2 className="text-lg font-bold">Riwayat Pencairan</h2><p className="mt-1 text-xs text-slate-400">{kitchenName} · {formatDate(transactionDate)}</p></div>
        <button onClick={onClose} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Tutup</button>
      </header>
      {error && <p role="alert" className="mt-3 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-xs text-emerald-200">{notice}</p>}
      {!detail ? <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-sm font-semibold">Daftar pencairan harian</h3><label className="mt-2 block text-[11px] text-slate-400">Tanggal Riwayat · {formatDate(selectedDate)}<input type="date" value={selectedDate} onChange={event => setSelectedDate(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100" /></label></div>
        </div>
        {busy && <p className="text-xs text-slate-400">Memuat...</p>}
        {!rows.length && !busy && <p className="rounded-xl border border-dashed border-slate-700 p-5 text-center text-xs text-slate-400">Belum ada Riwayat untuk dapur dan tanggal ini.</p>}
        {rows.map(row => <button key={row.id} onClick={() => void openDetail(row.id)} className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-left hover:border-emerald-700">
          <span><span className="block text-sm font-semibold">{formatTitle(row.title) || 'Pencairan'}</span><span className="mt-1 block text-[11px] text-slate-400">Versi {row.version} · Dibuat {dateTime(row.created_at)}</span></span>
          <span className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300"><span>RAB Rp {money(row.payload?.totalRab)}</span><span>OPS Rp {money(row.payload?.totalOpsHarian)}</span><span>Total Rp {money(row.payload?.totalOverall)}</span><span className="font-semibold text-emerald-300">Buka</span></span>
        </button>)}
        {rows.length > 0 && <div className="flex flex-wrap justify-end gap-x-5 gap-y-1 rounded-xl border border-slate-700 bg-slate-900 p-3 text-right text-xs"><span>Total RAB <strong className="ml-1">Rp {money(rows.reduce((sum, row) => sum + Number(row.payload?.totalRab ?? 0), 0))}</strong></span><span>Total OPS <strong className="ml-1">Rp {money(rows.reduce((sum, row) => sum + Number(row.payload?.totalOpsHarian ?? 0), 0))}</strong></span><span>Total keseluruhan <strong className="ml-1">Rp {money(rows.reduce((sum, row) => sum + Number(row.payload?.totalOverall ?? 0), 0))}</strong></span></div>}
      </div> : <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold">{formatTitle(detail.history.title) || 'Pencairan'}</h3><p className="mt-1 text-[11px] text-slate-400">Versi {detail.history.version} · {detail.locked && role !== 'admin' ? 'Terkunci' : 'Dapat diperbarui'}</p></div>
          <div className="flex flex-wrap gap-2">
            {canEdit && role === 'admin' && <button disabled={busy} onClick={() => onLoadSnapshot(detail.history.payload)} className="rounded-lg border border-emerald-700 bg-emerald-950/40 px-3 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-40">Load ke Form</button>}
            {role === 'admin' && <button disabled={busy} onClick={() => void deleteHistory()} className="rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-40">Hapus transaksi</button>}
          <button onClick={() => { setDetail(null); void load() }} className="rounded-lg border border-slate-700 px-3 py-2 text-xs">Kembali</button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total RAB</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalRab)}</p></div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total Ops Harian</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalOpsHarian)}</p></div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3"><p className="text-[11px] text-slate-400">Total Keseluruhan</p><p className="mt-1 text-lg font-semibold">Rp {money(detail.history.payload.totalOverall)}</p></div>
        </div>
        {canEdit && <section className="rounded-xl border border-emerald-800/70 bg-emerald-950/15 p-3">
          <h4 className="text-xs font-semibold">Perubahan pencairan</h4>
          <p className="mt-1 text-[11px] text-slate-400">Pilih Revisi atau Kekurangan, lalu pilih transaksi yang akan diubah. Tambahan untuk membuat transaksi baru.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['REVISI', 'KEKURANGAN', 'TAMBAHAN'] as const).map(type => <button key={type} type="button" data-option-button="true" data-selected={changeType === type} onClick={() => setChangeType(type)} className="rounded-lg border px-3 py-2 text-xs font-semibold">{type}</button>)}
          </div>
          {changeType !== 'TAMBAHAN' && <div className="mt-3 max-h-52 space-y-1 overflow-auto rounded-lg border border-slate-800 p-2">
            {selectableEntries.map(entry => <label key={entry.key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-800/70">
              <input type="checkbox" checked={selectedKeys.includes(entry.key)} onChange={event => setSelectedKeys(current => event.target.checked ? [...current, entry.key] : current.filter(key => key !== entry.key))} />
              <span className="min-w-0 flex-1">{entry.label}</span><span className="tabular-nums text-slate-300">Rp {entry.amount}</span>
            </label>)}
            {!selectableEntries.length && <p className="p-2 text-xs text-slate-400">Tidak ada baris transaksi yang dapat dipilih.</p>}
          </div>}
          <div className="mt-3 flex justify-end">
            <button type="button" disabled={busy || (changeType !== 'TAMBAHAN' && selectedKeys.length === 0)} onClick={() => onStartChange(detail.history.payload, changeType, selectedKeys)} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Pilih dan lanjut ke Form</button>
          </div>
        </section>}
                <div className="rounded-xl border border-slate-800 bg-slate-900 p-3"><h4 className="mb-2 text-xs font-semibold">Output saat ini</h4><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">{String(detail.history.payload.output ?? '')}</pre></div>
        <div><h4 className="mb-2 text-xs font-semibold">Perubahan tersimpan</h4><div className="space-y-2">{selectedEvent.map(event => <div key={event.id} className="rounded-lg border border-slate-800 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-xs font-semibold text-emerald-300">{event.event_type}</span><span className="text-[10px] text-slate-500">{dateTime(event.created_at)}</span></div><p className="mt-1 text-xs text-slate-300">{event.summary || 'Perubahan tersimpan'}</p><button onClick={() => void copyEventOutput(event)} className="mt-2 rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200">Salin</button></div>)}</div></div>

        {!canEdit && <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-xs text-amber-200">Riwayat terkunci. Hanya Admin yang dapat mengubahnya.</p>}
      </div>}
    </section>
  </div>
}
