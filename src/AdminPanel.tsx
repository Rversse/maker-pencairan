import { useCallback, useEffect, useState } from 'react'
import { supabase } from './lib/supabase'

type Kitchen = { id: string; name: string; is_active: boolean }
type Accountant = {
  user_id: string
  display_name: string
  is_active: boolean
  email: string | null
  must_change_credential: boolean
  credential_updated_at: string | null
  kitchen: Kitchen | null
  login_lock: { failed_attempts: number; locked_at: string | null; last_failed_at: string | null } | null
}
type AdminList = {
  accountants: Accountant[]
  available_kitchens: Kitchen[]
}
type CredentialNotice = { title: string; kitchen: string; password: string }
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/

async function adminRequest<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('maker-admin-accounts', {
    body,
    headers: { Authorization: `Bearer ${token}` }
  })
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Permintaan gagal.')
  return data as T
}

type DailyKitchenStatus = { id: string; name: string; submitted: boolean }
type DailyStatusResponse = {
  transaction_date: string
  kitchens: Array<{ id: string; name: string }>
  submitted_kitchen_ids: string[]
}

async function historyAdminRequest<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('maker-history', {
    body,
    headers: { Authorization: `Bearer ${token}` }
  })
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Status input gagal dimuat.')
  return data as T
}

function localDateIso() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDailyDate(value: string) {
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(value + 'T12:00:00'))
}

function generatePassword(includeSymbols: boolean) {
  const letters = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
  const numbers = '23456789'
  const symbols = '!@#$%^&*()-_=+[]{}?'
  const pool = letters + numbers + (includeSymbols ? symbols : '')
  const randomIndex = (max: number) => {
    const buffer = new Uint32Array(1)
    crypto.getRandomValues(buffer)
    return buffer[0] % max
  }
  const chars = [letters[randomIndex(letters.length)], numbers[randomIndex(numbers.length)]]
  while (chars.length < 16) chars.push(pool[randomIndex(pool.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

function EyeIcon({ visible }: { visible: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visible && <path d="m4 4 16 16" />}</svg>
}

export default function AdminPanel({ token }: { token: string }) {
  const [data, setData] = useState<AdminList>({ accountants: [], available_kitchens: [] })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [kitchenId, setKitchenId] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [showInitialPassword, setShowInitialPassword] = useState(false)
  const [includeSymbols, setIncludeSymbols] = useState(false)
  const [showResetPasswords, setShowResetPasswords] = useState<Record<string, boolean>>({})
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<CredentialNotice | null>(null)
  const [toast, setToast] = useState('')
  const [dailyStatus, setDailyStatus] = useState<DailyKitchenStatus[]>([])
  const [dailyStatusDate, setDailyStatusDate] = useState(localDateIso())
  const [dailyStatusLoading, setDailyStatusLoading] = useState(true)
  const [dailyStatusError, setDailyStatusError] = useState('')

  const load = useCallback(async () => {
    await Promise.resolve()
    setLoading(true)
    setError('')
    try {
      const result = await adminRequest<AdminList & { ok: boolean }>(token, { action: 'list' })
      setData({ accountants: result.accountants ?? [], available_kitchens: result.available_kitchens ?? [] })
      setKitchenId((current) => current && result.available_kitchens.some((k) => k.id === current)
        ? current
        : result.available_kitchens[0]?.id ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat daftar akun.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const loadDailyStatus = useCallback(async () => {
    setDailyStatusLoading(true)
    setDailyStatusError('')
    const transactionDate = localDateIso()
    try {
      const result = await historyAdminRequest<DailyStatusResponse>(token, {
        action: 'admin_daily_status',
        transaction_date: transactionDate
      })
      const submittedIds = new Set(result.submitted_kitchen_ids ?? [])
      setDailyStatus((result.kitchens ?? []).map(kitchen => ({
        ...kitchen,
        submitted: submittedIds.has(kitchen.id)
      })))
      setDailyStatusDate(result.transaction_date)
    } catch (err) {
      setDailyStatusError(err instanceof Error ? err.message : 'Gagal memuat status input harian.')
    } finally {
      setDailyStatusLoading(false)
    }
  }, [token])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadDailyStatus() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadDailyStatus])


  async function createAccount() {
    const kitchen = data.available_kitchens.find((item) => item.id === kitchenId)
    if (!kitchen || !PASSWORD_PATTERN.test(initialPassword)) return
    setBusy('create')
    setError('')
    setMessage('')
    try {
      const result = await adminRequest<{ email: string; kitchen: Kitchen }>(token, {
        action: 'create_account',
        kitchen_id: kitchen.id,
        password: initialPassword
      })
      setNotice({ title: 'Akun berhasil dibuat', kitchen: result.kitchen.name, password: initialPassword })
      setInitialPassword('')
      setMessage(`Akun Akuntan ${kitchen.name} berhasil dibuat.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat akun.')
    } finally {
      setBusy('')
    }
  }

  async function resetPassword(account: Accountant) {
    const password = resetPasswords[account.user_id] ?? ''
    if (!PASSWORD_PATTERN.test(password)) return
    setBusy(account.user_id)
    setError('')
    setMessage('')
    try {
      await adminRequest(token, { action: 'reset_password', user_id: account.user_id, password })
      setNotice({ title: 'Password berhasil dibuat', kitchen: account.kitchen?.name ?? account.display_name, password })
      setResetPasswords((current) => ({ ...current, [account.user_id]: '' }))
      setMessage(`Password akun ${account.display_name} berhasil direset. Sesi lama sudah dicabut.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mereset password.')
    } finally {
      setBusy('')
    }
  }

  async function unlockKitchenLogin(account: Accountant) {
    if (!account.kitchen) return
    setBusy(account.user_id)
    setError('')
    setMessage('')
    try {
      await adminRequest(token, { action: 'unlock_kitchen_login', kitchen_id: account.kitchen.id })
      setMessage('Blokir login dapur ' + account.kitchen.name + ' berhasil dibuka.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka blokir login.')
    } finally {
      setBusy('')
    }
  }

  async function setAccountStatus(account: Accountant, isActive: boolean) {
    setBusy(account.user_id)
    setError('')
    setMessage('')
    try {
      await adminRequest(token, { action: 'set_account_status', user_id: account.user_id, is_active: isActive })
      setMessage(isActive
        ? `Akun ${account.display_name} diaktifkan kembali.`
        : `Akun ${account.display_name} dinonaktifkan dan seluruh session dicabut.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah status akun.')
    } finally {
      setBusy('')
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setToast('Disalin ke clipboard.')
      window.setTimeout(() => setToast(''), 2400)
    } catch {
      setToast('Clipboard tidak tersedia. Salin teks secara manual.')
      window.setTimeout(() => setToast(''), 3000)
    }
  }

  return (
    <section className="mp-admin-panel mx-auto w-full max-w-5xl space-y-5">
      {toast && <div role="status" className="mp-admin-toast fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md rounded-xl border border-teal-700/60 bg-slate-900 px-4 py-3 text-sm text-teal-100 shadow-xl sm:bottom-5 sm:left-auto sm:right-5">{toast}</div>}
      {error && <div role="alert" className="rounded-xl border border-rose-700/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-3 text-sm text-emerald-200">{message}</div>}

      {notice && (
        <div className="mp-admin-credential-notice rounded-2xl border border-teal-700/55 bg-teal-950/20 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-emerald-100">{notice.title}</h3>
            <button type="button" onClick={() => setNotice(null)} className="rounded-lg border border-emerald-700/60 px-2.5 py-1.5 text-xs text-emerald-100">Tutup</button>
          </div>
          
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <div className="min-w-0 rounded-lg bg-slate-950/80 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Dapur</p>
              <p className="break-all font-mono text-sm text-white">{notice.kitchen}</p>
              <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">Password</p>
              <p className="break-all font-mono text-sm text-white">{notice.password}</p>
            </div>
            <button type="button" onClick={() => void copy(`Dapur: ${notice.kitchen}\nPassword: ${notice.password}`)} className="rounded-lg border border-emerald-700/70 px-3 py-2 text-xs font-semibold text-emerald-100">Salin</button>
          </div>
          <p className="mt-2 text-xs text-amber-200">Hanya ditampilkan sekali, simpan dan kirim data ke Akuntan.</p>
        </div>
      )}

      <div className="mp-admin-card rounded-2xl border border-slate-700/70 bg-slate-900/55 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3"><div><h3 className="font-semibold text-white">Manajemen Akuntan</h3><p className="mt-1 text-xs text-slate-400">Buat akun baru dan kelola kredensial dapur.</p></div><button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)} aria-label="Muat ulang daftar akun" title="Muat ulang" className="grid h-9 w-9 place-items-center rounded-lg border border-slate-600 bg-slate-800/70 text-slate-200">↻</button></div>
        <div className="mb-5 rounded-xl border border-slate-700/75 bg-slate-950/45 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-white">Status Input Hari Ini</h4>
              <p className="mt-0.5 text-[10px] text-slate-400">{formatDailyDate(dailyStatusDate)} · {dailyStatus.filter(item => item.submitted).length} dari {dailyStatus.length} dapur sudah input</p>
            </div>
            <button type="button" onClick={() => void loadDailyStatus()} disabled={dailyStatusLoading} aria-label="Muat ulang status input harian" title="Muat ulang status" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-700 bg-slate-800/70 text-sm text-slate-200 disabled:opacity-40">↻</button>
          </div>
          {dailyStatusError ? (
            <p role="alert" className="mt-3 rounded-lg border border-rose-800/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">{dailyStatusError}</p>
          ) : dailyStatusLoading ? (
            <p className="mt-3 text-xs text-slate-500">Memuat status dapur...</p>
          ) : dailyStatus.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">Tidak ada dapur aktif.</p>
          ) : (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-slate-800/80">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-slate-900/95 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">Dapur</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {dailyStatus.map(kitchen => (
                    <tr key={kitchen.id} className="transition-colors">
                      <th scope="row" className="px-3 py-2 font-medium text-slate-200">{kitchen.name}</th>
                      <td className="px-3 py-2 text-right">
                        <span className={`inline-flex items-center justify-end gap-2 font-medium ${kitchen.submitted ? 'text-emerald-300' : 'text-rose-300'}`}>
                          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${kitchen.submitted ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                          {kitchen.submitted ? 'Sudah input' : 'Belum input'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <h3 className="font-semibold text-white">Buat Akun</h3>
        {loading ? <p className="mt-3 text-sm text-slate-400">Memuat daftar dapur...</p> : data.available_kitchens.length === 0 ? (
          <p className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400">Semua dapur aktif sudah memiliki akun Akuntan.</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[minmax(180px,0.8fr)_minmax(240px,1.2fr)_auto_auto] md:items-end">
            <label className="block text-xs font-medium text-slate-300">Dapur
              <select value={kitchenId} onChange={(e) => setKitchenId(e.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white">
                {data.available_kitchens.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-300">Password
              <div className="mt-1.5 flex gap-2"><div className="relative min-w-0 flex-1"><input type={showInitialPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={16} value={initialPassword} onChange={(e) => setInitialPassword(e.target.value.replace(/\s/g, '').slice(0, 16))} placeholder="Password (16 karakter)" className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 pr-12 text-sm text-white placeholder:text-slate-500 outline-none" /><button type="button" onClick={() => setShowInitialPassword((value) => !value)} aria-label={showInitialPassword ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showInitialPassword} /></button></div><button type="button" onClick={() => setInitialPassword(generatePassword(includeSymbols))} className="h-11 shrink-0 rounded-lg border border-emerald-700/70 px-3 text-xs font-semibold text-emerald-200">Acak</button></div>
            </label>
            <button type="button" aria-pressed={includeSymbols} onClick={() => setIncludeSymbols((value) => !value)} className={`h-11 rounded-lg border border-slate-600 px-3 text-xs font-semibold text-slate-300 transition ${includeSymbols ? 'bg-emerald-500/15' : 'bg-slate-800/70'}`}><span className="mr-1.5">{includeSymbols ? '✓' : '＋'}</span>Tambah Simbol</button>
            <button type="button" data-button-kind="primary" disabled={!kitchenId || !PASSWORD_PATTERN.test(initialPassword) || Boolean(busy)} onClick={() => void createAccount()} className="h-11 min-w-24 rounded-lg px-5 text-sm font-semibold disabled:opacity-40">{busy === 'create' ? 'Membuat...' : 'Submit'}</button>
          </div>
        )}
        
      </div>

      <div className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-white">Daftar Akun</h3>
            <p className="mt-1 text-xs text-slate-400">{data.accountants.length} akun terdaftar</p>
          </div>
        </div>
        {loading ? <p className="mt-4 text-sm text-slate-400">Memuat akun...</p> : data.accountants.length === 0 ? (
          <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400">Belum ada akun Akuntan. Buat akun dari dapur aktif di atas.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {data.accountants.map((account) => (
              <article key={account.user_id} className="rounded-xl border border-slate-700/80 bg-slate-950/55 p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-white">{account.display_name}</h4>
                    <p className="mt-0.5 break-all font-mono text-xs text-slate-400">{account.kitchen?.name ?? 'Dapur belum ditetapkan'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={account.is_active ? 'rounded-full border border-emerald-700/60 bg-emerald-950/40 px-2.5 py-1 text-[10px] text-emerald-300' : 'rounded-full border border-rose-700/60 bg-rose-950/40 px-2.5 py-1 text-[10px] text-rose-300'}>{account.is_active ? 'Aktif' : 'Nonaktif'}</span>
                    {account.must_change_credential && <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2.5 py-1 text-[10px] text-amber-200">Ganti password</span>}
                    {account.login_lock?.locked_at && <span className="rounded-full border border-rose-700/70 bg-rose-950/40 px-2.5 py-1 text-[10px] font-semibold text-rose-200">Login diblokir · 5/5</span>}
                    {!account.login_lock?.locked_at && Boolean(account.login_lock?.failed_attempts) && <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2.5 py-1 text-[10px] text-amber-200">Percobaan gagal · {account.login_lock?.failed_attempts}/5</span>}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
                  <div className="flex min-w-0 gap-1.5"><div className="relative min-w-0 flex-1"><input type={showResetPasswords[account.user_id] ? 'text' : 'password'} autoComplete="new-password" maxLength={16} value={resetPasswords[account.user_id] ?? ''} onChange={(e) => setResetPasswords((current) => ({ ...current, [account.user_id]: e.target.value.replace(/\s/g, '').slice(0, 16) }))} placeholder="Password baru" className="h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 pr-12 text-xs text-white placeholder:text-slate-500 outline-none" /><button type="button" onClick={() => setShowResetPasswords((current) => ({ ...current, [account.user_id]: !current[account.user_id] }))} aria-label={showResetPasswords[account.user_id] ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-9 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={Boolean(showResetPasswords[account.user_id])} /></button></div><button type="button" onClick={() => setResetPasswords((current) => ({ ...current, [account.user_id]: generatePassword(true) }))} className="rounded-lg border border-emerald-700/70 px-2.5 text-[10px] font-semibold text-emerald-200">Acak</button></div>
                  <button type="button" disabled={!PASSWORD_PATTERN.test(resetPasswords[account.user_id] ?? '') || Boolean(busy)} onClick={() => void resetPassword(account)} className="rounded-lg border border-amber-700/70 px-3 py-2 text-xs font-semibold text-amber-200 disabled:opacity-40">{busy === account.user_id ? 'Memproses...' : 'Reset'}</button>
                  {account.login_lock?.locked_at && <button type="button" disabled={Boolean(busy)} onClick={() => void unlockKitchenLogin(account)} className="rounded-lg border border-rose-700/70 px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-40">{busy === account.user_id ? 'Memproses...' : 'Buka blokir login'}</button>}
                  <button type="button" disabled={Boolean(busy)} onClick={() => void setAccountStatus(account, !account.is_active)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">{account.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
