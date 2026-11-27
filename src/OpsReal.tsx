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

export function OpsRealModal({ token, kitchenId, kitchenName, transactionDate, onClose, onSaved, initialAmount = '', initialNote = '', mode = 'create' }: BaseProps & {
  onClose: () => void
  onSaved: () => void
  initialAmount?: string
  initialNote?: string
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
        amount: value,
        note
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
            <h2 id="mp-ops-real-title" className="text-base font-bold text-slate-100">Catatan Belanja Operasional Real</h2>
            <p className="mt-1 text-xs text-slate-400">{kitchenName} · {dateLabel(transactionDate)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Tutup" className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 bg-slate-900 text-base text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-50">×</button>
        </div>
        <label htmlFor="mp-ops-real-amount" className="mt-5 mb-1.5 block text-xs font-semibold text-slate-300">Nominal</label>
        <div className="flex h-11 items-center rounded-lg border border-slate-700 bg-slate-950 px-3 focus-within:border-cyan-500">
          <span className="mr-2 text-sm font-semibold text-slate-400">Rp</span>
          <input
            id="mp-ops-real-amount"
            autoFocus
            inputMode="numeric"
            value={money(digits(amount))}
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

export function OpsRealHistoryItem(props: BaseProps) {
  const [amount, setAmount] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    try {
      const data = await request(props.token, {
        action: 'ops_real_get',
        kitchen_id: props.kitchenId,
        transaction_date: props.transactionDate
      })
      setAmount(data.record?.amount == null ? null : String(data.record.amount))
      setNote(data.record?.note == null ? '' : String(data.record.note))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Data OPS REAL gagal dimuat.')
    } finally {
      setBusy(false)
    }
  }, [props.token, props.kitchenId, props.transactionDate])
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])
  async function copy() {
    if (!amount) return
    try {
      const content = [
        '*Operasional Real*',
        dateLabel(props.transactionDate) + ' : Rp ' + money(amount),
        'Catatan : ' + (note ?? '')
      ].join('\n')
      await navigator.clipboard.writeText(content)
      setError('')
    } catch {
      setError('Clipboard tidak tersedia di browser ini.')
    }
  }
  async function remove() {
    if (!amount || busy) return
    const confirmed = window.confirm(
      'Hapus catatan OPS REAL ' + props.kitchenName + ' tanggal ' + dateLabel(props.transactionDate) + '?'
    )
    if (!confirmed) return

    setBusy(true)
    setError('')
    try {
      await request(props.token, {
        action: 'ops_real_delete',
        kitchen_id: props.kitchenId,
        transaction_date: props.transactionDate
      })
      setAmount(null)
      setNote(null)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OPS REAL gagal dihapus.')
    } finally {
      setBusy(false)
    }
  }
  if (!busy && amount === null && !error) return null

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-900/70 bg-cyan-950/20 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-cyan-200">OPS REAL : {busy ? 'Memuat...' : amount ? money(amount) : 'Belum diisi'}</p>
          {amount && (
            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-300 [overflow-wrap:anywhere]">
              <span className="font-semibold text-slate-400">Catatan:</span>{' '}
              {note?.trim() ? note : 'Belum diisi (data lama)'}
            </p>
          )}
          {error && <p role="alert" className="mt-1 text-[10px] text-rose-300">{error}</p>}
        </div>
        {amount && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button type="button" disabled={busy} onClick={() => void copy()} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Copy</button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Edit</button>
            <button type="button" disabled={busy} onClick={() => void remove()} className="rounded-md border border-rose-800/70 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-950/40 disabled:opacity-40">Hapus</button>
          </div>
        )}
      </div>
      {editing && (
        <OpsRealModal
          {...props}
          mode="edit"
          initialAmount={amount ?? ''}
          initialNote={note ?? ''}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void load() }}
        />
      )}
    </>
  )
}
