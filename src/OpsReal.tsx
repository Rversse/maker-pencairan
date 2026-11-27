import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

type BaseProps = {
  token: string
  kitchenId: string
  kitchenName: string
  transactionDate: string
}
const money = (value: string | number) => new Intl.NumberFormat('id-ID').format(Number(value) || 0)
const digits = (value: string) => value.replace(/\D/g, '')
const dateLabel = (value: string) => {
  const [year, month, day] = value.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  return day && month && year ? day + '-' + (months[Number(month) - 1] ?? month) + '-' + year : value
}
async function request(token: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('maker-history', {
    body,
    headers: { Authorization: 'Bearer ' + token }
  })
  if (error instanceof FunctionsHttpError) {
    const payload = await error.context.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? error.message ?? 'OPS REAL gagal diproses.')
  }
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'OPS REAL gagal diproses.')
  return data
}

type OpsRealModalMode = 'create' | 'edit'

export function OpsRealModal({ token, kitchenId, kitchenName, transactionDate, onClose, onSaved, initialAmount = '', initialNote = '', initialVersion = 0, transactionId, mode = 'create' }: BaseProps & {
  onClose: () => void
  onSaved: () => void
  initialAmount?: string
  initialNote?: string
  initialVersion?: number
  transactionId?: string
  mode?: OpsRealModalMode
}) {
  const [amount, setAmount] = useState(initialAmount)
  const [note, setNote] = useState(initialNote)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const field = noteRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.max(field.scrollHeight, 88)}px`
  }, [note])
  async function save() {
    const value = digits(amount)
    if (!value || Number(value) <= 0) {
      setError('Masukkan nominal lebih dari Rp 0.')
      return
    }
    if (!note.trim()) {
      setError('Catatan wajib diisi.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await request(token, {
        action: mode === 'create' ? 'ops_real_create' : 'ops_real_update',
        kitchen_id: kitchenId,
        transaction_date: transactionDate,
        ...(mode === 'edit' ? { transaction_id: transactionId } : {}),
        amount: value,
        note,
        expected_version: initialVersion
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OPS REAL gagal disimpan.')
    } finally {
      setBusy(false)
    }
  }
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-black/75 p-3 sm:p-5">
      <section role="dialog" aria-modal="true" aria-labelledby="mp-ops-real-title" className="max-h-[calc(100dvh-1.5rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-2xl border border-slate-700 bg-[#111b2a] p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="mp-ops-real-title" className="text-base font-bold text-slate-100">OPS Real</h2>
            <p className="mt-1 text-xs text-slate-400">{kitchenName} · {dateLabel(transactionDate)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Tutup" className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-base text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-50">×</button>
        </div>
        <label htmlFor="mp-ops-real-amount" className="mt-5 mb-1.5 block text-xs font-semibold text-slate-300">Nominal</label>
        <div className="flex h-11 items-center rounded-lg border border-slate-700 bg-slate-950 px-3 focus-within:border-cyan-500">
          <input
            id="mp-ops-real-amount"
            autoFocus
            inputMode="numeric"
            value={amount ? money(digits(amount)) : ''}
            onChange={event => setAmount(digits(event.target.value))}
            onKeyDown={event => { if (event.key === 'Enter') void save() }}
            placeholder="0"
            className="w-full bg-transparent text-sm font-semibold text-white outline-none"
          />
        </div>
        <label htmlFor="mp-ops-real-note" className="mt-4 mb-1.5 block text-xs font-semibold text-slate-300">
          Catatan <span className="text-rose-400">*</span>
        </label>
        <textarea
          ref={noteRef}
          id="mp-ops-real-note"
          rows={3}
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder="Catatan wajib diisi..."
          className="block min-h-[88px] w-full max-w-full box-border resize-none overflow-hidden rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm font-normal leading-relaxed text-white outline-none placeholder:text-slate-500 focus:border-cyan-500 [overflow-wrap:anywhere]"
        />
        {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-button-kind="primary" disabled={busy} onClick={() => void save()} className="h-9 rounded-lg px-3 text-xs font-semibold disabled:opacity-40">{busy ? 'Menyimpan...' : 'Simpan'}</button>
        </div>
      </section>
    </div>,
    document.body
  )
}

type OpsRealRecord = {
  id: string
  amount: number
  note: string | null
  version: number
  source_created_role: string | null
  edited_role: string | null
}

export function OpsRealHistoryItem(props: BaseProps) {
  const [records, setRecords] = useState<OpsRealRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingRecord, setEditingRecord] = useState<OpsRealRecord | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const data = await request(props.token, {
        action: 'ops_real_get',
        kitchen_id: props.kitchenId,
        transaction_date: props.transactionDate
      })
      setRecords(Array.isArray(data.records) ? data.records : data.record ? [data.record] : [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Data OPS Real gagal dimuat.')
    } finally {
      setBusy(false)
    }
  }, [props.token, props.kitchenId, props.transactionDate])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    // Each mounted OPS Real list needs its own channel. Workspace and History
    // render this component together, so a shared topic would collide.
    const channel = supabase
      .channel('maker-ops-real-history-' + props.kitchenId + '-' + crypto.randomUUID())
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'transactions',
        filter: 'kitchen_id=eq.' + props.kitchenId
      }, () => { void loadRef.current() })
      .subscribe()
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadRef.current()
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void supabase.removeChannel(channel)
    }
  }, [props.kitchenId])

  async function copy(record: OpsRealRecord) {
    try {
      await navigator.clipboard.writeText([
        '*Operasional Real*',
        dateLabel(props.transactionDate) + ' : Rp ' + money(record.amount),
        'Catatan : ' + (record.note ?? '')
      ].join('\n'))
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
  }

  async function remove(record: OpsRealRecord) {
    if (busy) return
    if (!window.confirm('Hapus transaksi OPS Real sebesar Rp ' + money(record.amount) + ' untuk ' + props.kitchenName + ' tanggal ' + dateLabel(props.transactionDate) + '?')) return
    setBusy(true)
    setError('')
    try {
      await request(props.token, {
        action: 'ops_real_delete',
        kitchen_id: props.kitchenId,
        transaction_date: props.transactionDate,
        transaction_id: record.id,
        expected_version: record.version
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OPS - Pencairan Real gagal dihapus.')
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {busy && records.length === 0 ? <p className="text-xs text-slate-400">Memuat OPS - Pencairan Real...</p> : null}
      {records.map((record) => (
        <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-900/70 bg-cyan-950/20 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-cyan-200">OPS Real: {money(record.amount)}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300 [overflow-wrap:anywhere]">
              <span className="font-semibold text-slate-400">Catatan:</span> {record.note?.trim() || '-'}
            </p>
            <p className="mt-1 text-[10px] text-slate-400">
              Dibuat: {record.source_created_role ?? 'Tidak tercatat'}
              {record.edited_role ? ' · Terakhir diubah: ' + record.edited_role : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button type="button" disabled={busy} onClick={() => void copy(record)} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Copy</button>
            <button type="button" disabled={busy} onClick={() => setEditingRecord(record)} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Edit</button>
            <button type="button" disabled={busy} onClick={() => void remove(record)} className="rounded-md border border-rose-800/70 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-semibold text-rose-200 disabled:opacity-40">Hapus</button>
          </div>
        </div>
      ))}
      {error ? <p role="alert" className="text-[10px] text-rose-300">{error}</p> : null}
      {editingRecord ? (
        <OpsRealModal
          {...props}
          mode="edit"
          transactionId={editingRecord.id}
          initialAmount={String(editingRecord.amount)}
          initialNote={editingRecord.note ?? ''}
          initialVersion={editingRecord.version}
          onClose={() => setEditingRecord(null)}
          onSaved={() => { setEditingRecord(null); void load() }}
        />
      ) : null}
    </div>
  )
}
