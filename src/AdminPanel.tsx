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
}
type AdminList = {
  accountants: Accountant[]
  available_kitchens: Kitchen[]
}
type CredentialNotice = { title: string; email: string; password: string }
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/

async function adminRequest<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('maker-admin-accounts', {
    body,
    headers: { Authorization: `Bearer ${token}` }
  })
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Permintaan gagal.')
  return data as T
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

function PasswordGuidance({ value }: { value: string }) {
  const checks = [{ label: '8 karakter', valid: value.length >= 8 }, { label: 'Huruf', valid: /[A-Za-z]/.test(value) }, { label: 'Angka', valid: /\d/.test(value) }]
  const score = checks.filter((item) => item.valid).length + (/[\W_]/.test(value) ? 1 : 0)
  const strength = !value ? 'Belum diisi' : score <= 1 ? 'Lemah' : score === 2 ? 'Cukup' : score === 3 ? 'Baik' : 'Kuat'
  return <div className="mt-2 space-y-2"><div className="flex h-1.5 gap-1 overflow-hidden rounded-full bg-slate-800">{[1,2,3,4].map((n) => <span key={n} className={`flex-1 rounded-full ${score >= n ? 'bg-emerald-400' : 'bg-slate-800'}`} />)}</div><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] text-slate-500">Kekuatan: {strength}</span><div className="flex flex-wrap gap-x-3">{checks.map((item) => <span key={item.label} className={`text-[11px] ${item.valid ? 'text-emerald-400' : 'text-slate-500'}`}>{item.valid ? '✓' : '○'} {item.label}</span>)}</div></div><p className="text-[11px] text-slate-500">8–16 karakter, minimal huruf dan angka. Simbol opsional, tanpa spasi.</p></div>
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

  const load = useCallback(async () => {
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

  useEffect(() => { void load() }, [load])

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
      setNotice({ title: 'Akun berhasil dibuat', email: result.email, password: initialPassword })
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
      setNotice({ title: 'Password berhasil dibuat', email: account.email ?? '', password })
      setResetPasswords((current) => ({ ...current, [account.user_id]: '' }))
      setMessage(`Password akun ${account.display_name} berhasil direset. Sesi lama sudah dicabut.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mereset password.')
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
      setMessage('Disalin ke clipboard.')
    } catch {
      setMessage('Clipboard tidak tersedia. Salin teks secara manual.')
    }
  }

  return (
    <section className="mx-auto w-full max-w-5xl space-y-4">
      <div className="rounded-2xl border border-slate-700/80 bg-slate-900/80 p-4 shadow-xl sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-400">Manajemen Akuntan</p>
            <h2 className="mt-1 text-xl font-bold text-white">Akuntan</h2>
            
          </div>
          <button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200">Muat ulang</button>
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-700/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-3 text-sm text-emerald-200">{message}</div>}

      {notice && (
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-950/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-emerald-100">{notice.title}</h3>
            <button type="button" onClick={() => setNotice(null)} className="rounded-lg border border-emerald-700/60 px-2.5 py-1.5 text-xs text-emerald-100">Tutup</button>
          </div>
          
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <div className="min-w-0 rounded-lg bg-slate-950/80 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Email</p>
              <p className="break-all font-mono text-sm text-white">{notice.email}</p>
              <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">Password</p>
              <p className="break-all font-mono text-sm text-white">{notice.password}</p>
            </div>
            <button type="button" onClick={() => void copy(`Email: ${notice.email}\nPassword: ${notice.password}`)} className="rounded-lg border border-emerald-700/70 px-3 py-2 text-xs font-semibold text-emerald-100">Salin</button>
          </div>
          <p className="mt-2 text-xs text-amber-200">Hanya ditampilkan sekali, simpan dan kirim data ke Akuntan.</p>
        </div>
      )}

      <div className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 sm:p-5">
        <h3 className="font-semibold text-white">Buat Akun</h3>
        {loading ? <p className="mt-3 text-sm text-slate-400">Memuat daftar dapur...</p> : data.available_kitchens.length === 0 ? (
          <p className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400">Semua dapur aktif sudah memiliki akun Akuntan.</p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(180px,0.8fr)_minmax(240px,1.2fr)_auto] md:items-end">
            <label className="block text-xs font-medium text-slate-300">Dapur
              <select value={kitchenId} onChange={(e) => setKitchenId(e.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white">
                {data.available_kitchens.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-300">Password
              <div className="mt-1.5 flex gap-2"><div className="relative min-w-0 flex-1"><input type={showInitialPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={16} value={initialPassword} onChange={(e) => setInitialPassword(e.target.value.replace(/\s/g, '').slice(0, 16))} placeholder="Password (16 karakter)" className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 pr-12 text-sm text-white placeholder:text-slate-500 outline-none focus:border-emerald-500" /><button type="button" onClick={() => setShowInitialPassword((value) => !value)} aria-label={showInitialPassword ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showInitialPassword} /></button></div><button type="button" onClick={() => setInitialPassword(generatePassword(includeSymbols))} className="h-11 shrink-0 rounded-lg border border-emerald-700/70 px-3 text-xs font-semibold text-emerald-200">Acak</button></div>
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={includeSymbols} onChange={(e) => setIncludeSymbols(e.target.checked)} className="accent-emerald-500" />Sertakan simbol saat generate</label>
            <button type="button" data-button-kind="primary" disabled={!kitchenId || !PASSWORD_PATTERN.test(initialPassword) || Boolean(busy)} onClick={() => void createAccount()} className="h-11 rounded-lg px-4 text-sm font-semibold disabled:opacity-40">{busy === 'create' ? 'Membuat...' : 'Submit'}</button>
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
                    <p className="mt-0.5 break-all font-mono text-xs text-slate-400">{account.email ?? 'Email tidak ditemukan'}</p>
                    <p className="mt-1 text-xs text-slate-400">Dapur: {account.kitchen?.name ?? 'Belum ada assignment'}{account.kitchen && !account.kitchen.is_active ? ' · Nonaktif' : ''}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={account.is_active ? 'rounded-full border border-emerald-700/60 bg-emerald-950/40 px-2.5 py-1 text-[11px] text-emerald-300' : 'rounded-full border border-rose-700/60 bg-rose-950/40 px-2.5 py-1 text-[11px] text-rose-300'}>{account.is_active ? 'Aktif' : 'Nonaktif'}</span>
                    {account.must_change_credential && <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2.5 py-1 text-[11px] text-amber-200">Ganti password</span>}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
                  <div className="flex min-w-0 gap-1.5"><div className="relative min-w-0 flex-1"><input type={showResetPasswords[account.user_id] ? 'text' : 'password'} autoComplete="new-password" maxLength={16} value={resetPasswords[account.user_id] ?? ''} onChange={(e) => setResetPasswords((current) => ({ ...current, [account.user_id]: e.target.value.replace(/\s/g, '').slice(0, 16) }))} placeholder="Password baru" className="h-10 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-3 pr-12 text-xs text-white placeholder:text-slate-500 outline-none focus:border-emerald-500" /><button type="button" onClick={() => setShowResetPasswords((current) => ({ ...current, [account.user_id]: !current[account.user_id] }))} aria-label={showResetPasswords[account.user_id] ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-9 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={Boolean(showResetPasswords[account.user_id])} /></button></div><button type="button" onClick={() => setResetPasswords((current) => ({ ...current, [account.user_id]: generatePassword(true) }))} className="rounded-lg border border-emerald-700/70 px-2.5 text-[11px] font-semibold text-emerald-200">Acak</button></div>
                  <button type="button" disabled={!PASSWORD_PATTERN.test(resetPasswords[account.user_id] ?? '') || Boolean(busy)} onClick={() => void resetPassword(account)} className="rounded-lg border border-amber-700/70 px-3 py-2 text-xs font-semibold text-amber-200 disabled:opacity-40">{busy === account.user_id ? 'Memproses...' : 'Reset'}</button>
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
