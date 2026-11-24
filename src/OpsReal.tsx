import { useCallback, useEffect, useState } from 'react'
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
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'OPS REAL gagal diproses.')
  return data
}

export function OpsRealModal({ token, kitchenId, kitchenName, transactionDate, onClose, onSaved, initialAmount = '' }: BaseProps & {
  onClose: () => void
  onSaved: () => void
  initialAmount?: string
}) {
  const [amount, setAmount] = useState(initialAmount)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    const value = digits(amount)
    if (!value || Number(value) <= 0) {
      setError('Masukkan nominal lebih dari Rp 0.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await request(token, {
        action: 'ops_real_save',
        kitchen_id: kitchenId,
        transaction_date: transactionDate,
        amount: value
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OPS REAL gagal disimpan.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-3 sm:p-5">
      <section role="dialog" aria-modal="true" aria-labelledby="mp-ops-real-title" className="w-full max-w-sm rounded-2xl border border-slate-700 bg-[#111b2a] p-4 shadow-2xl">
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
        {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-button-kind="primary" disabled={busy} onClick={() => void save()} className="h-9 rounded-lg px-3 text-xs font-semibold disabled:opacity-40">{busy ? 'Menyimpan...' : 'Simpan'}</button>
        </div>
      </section>
    </div>
  )
}

export function OpsRealHistoryItem(props: BaseProps) {
  const [amount, setAmount] = useState<string | null>(null)
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
      await navigator.clipboard.writeText(dateLabel(props.transactionDate) + ', OPS REAL : ' + money(amount))
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OPS REAL gagal dihapus.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-900/70 bg-cyan-950/20 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-cyan-200">OPS REAL : {busy ? 'Memuat...' : amount ? money(amount) : 'Belum diisi'}</p>
          {error && <p role="alert" className="mt-1 text-[10px] text-rose-300">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button type="button" disabled={!amount || busy} onClick={() => void copy()} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Copy</button>
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-md border border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-40">Edit</button>
          <button type="button" disabled={!amount || busy} onClick={() => void remove()} className="rounded-md border border-rose-800/70 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-950/40 disabled:opacity-40">Hapus</button>
        </div>
      </div>
      {editing && (
        <OpsRealModal
          {...props}
          initialAmount={amount ?? ''}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void load() }}
        />
      )}
    </>
  )
}
