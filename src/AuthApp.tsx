import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import MakerWorkspace from './App'
import AdminPanel from './AdminPanel'
import { supabase } from './lib/supabase'

type MakerUser = { id: string; role: 'admin' | 'accountant'; display_name: string }
type AuthState = { token: string; user: MakerUser; mustChange: boolean }
type AuthResponse = {
  ok: boolean
  access_token?: string
  expires_at?: string
  must_change_credential?: boolean
  user?: MakerUser
  error?: string
}

const SESSION_KEY = 'maker-session-token'
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)[\x21-\x7E]{8,16}$/

async function authRequest(body: Record<string, unknown>, token?: string): Promise<AuthResponse> {
  const { data, error } = await supabase.functions.invoke('maker-auth', {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  })
  if (error || data?.error) {
    const context = (error as unknown as { context?: Response } | null)?.context
    let serverMessage = data?.error
    if (!serverMessage && context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: string; message?: string }
        serverMessage = payload.error ?? payload.message
      } catch {
        // Keep the SDK message when the response body is not JSON.
      }
    }
    const authError = new Error(serverMessage ?? error?.message ?? 'Permintaan autentikasi gagal.') as Error & { status?: number }
    authError.status = (error as unknown as { context?: Response } | null)?.context?.status
    throw authError
  }
  return data as AuthResponse
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
type KitchenOption = { id: string; name: string }

function LoginScreen({ onLogin }: { onLogin: (role: 'admin' | 'accountant', kitchenId: string, password: string) => Promise<void> }) {
  const [role, setRole] = useState<'admin' | 'accountant' | null>(null)
  const [kitchens, setKitchens] = useState<KitchenOption[]>([])
  const [kitchenId, setKitchenId] = useState('')
  const [loadingKitchens, setLoadingKitchens] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shake, setShake] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    if (role !== 'accountant' || kitchens.length) return
    let active = true
    void authRequest({ action: 'list_kitchens' }).then((result) => {
      if (!active) return
      const items = (result as AuthResponse & { kitchens?: KitchenOption[] }).kitchens ?? []
      setKitchens(items)
      setKitchenId(items[0]?.id ?? '')
      if (!items.length) setError('Belum ada akun dapur aktif yang dapat digunakan.')
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : 'Daftar dapur gagal dimuat.')
    }).finally(() => { if (active) setLoadingKitchens(false) })
    return () => { active = false }
  }, [role, kitchens.length])

  async function submit() {
    if (!role) return
    const migrationPin = role === 'admin' && /^\d{8}$/.test(password)
    if (!migrationPin && !PASSWORD_PATTERN.test(password)) {
      setError('Password harus 8–16 karakter, minimal huruf dan angka, tanpa spasi.')
      passwordRef.current?.focus()
      return
    }
    if (role === 'accountant' && !kitchenId) {
      setError('Pilih dapur terlebih dahulu.')
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await onLogin(role, role === 'accountant' ? kitchenId : '', password)
    } catch (err) {
      const status = (err as Error & { status?: number })?.status
      const rawMessage = err instanceof Error ? err.message : 'Login gagal.'
      const message = status === 401
        ? role === 'admin' ? 'Password Admin salah.' : 'Password salah.'
        : status === 423 ? 'Akses login dapur ini diblokir setelah 5 kali percobaan gagal. Silakan hubungi Admin untuk membuka blokir.' : rawMessage
      setError(message)
      if (role === 'admin' && status === 401) {
        setPassword('')
        setShake(false)
        requestAnimationFrame(() => { setShake(true); passwordRef.current?.focus() })
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <main className="mp-auth-screen flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <div className="mp-auth-card w-full max-w-md rounded-2xl border border-slate-700/70 bg-slate-900/85 p-6 shadow-xl sm:p-8">
        <div className="mb-7 text-center">
          <p className="text-lg font-bold tracking-tight text-white">Maker Pencairan</p>
          <h1 className="mt-1 text-xs font-semibold uppercase tracking-[0.24em] text-emerald-400">LOGIN</h1>
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-700 bg-slate-950 p-1">
          <button type="button" data-option-button="true" data-selected={role === 'admin'} onClick={() => { setRole('admin'); setLoadingKitchens(false); setError(''); setPassword('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Admin</button>
          <button type="button" data-option-button="true" data-selected={role === 'accountant'} onClick={() => { setRole('accountant'); setLoadingKitchens(kitchens.length === 0); setError(''); setPassword('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Akuntan</button>
        </div>
        <div className={`overflow-hidden transition-all duration-300 ease-out ${role ? 'mt-5 max-h-[420px] translate-y-0 opacity-100' : 'max-h-0 translate-y-2 opacity-0'}`}>
          {role && (
            <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="space-y-4">
              {role === 'accountant' && (
                <label className="block text-sm font-medium text-slate-300">Pilih dapur
                  <select value={kitchenId} onChange={(event) => { setKitchenId(event.target.value); setError('') }} disabled={loadingKitchens || kitchens.length === 0} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500">
                    {loadingKitchens && <option value="">Memuat dapur...</option>}
                    {!loadingKitchens && !kitchens.length && <option value="">Tidak ada akun dapur aktif</option>}
                    {kitchens.map((kitchen) => <option key={kitchen.id} value={kitchen.id}>{kitchen.name}</option>)}
                  </select>
                </label>
              )}
              <label className="block text-sm font-medium text-slate-300">{role === 'admin' ? 'Password Admin' : 'Password'}
                <div className="relative mt-1.5">
                  <input ref={passwordRef} type={showPassword ? 'text' : 'password'} autoComplete="current-password" required minLength={8} maxLength={16} value={password}
                    onChange={(event) => { setPassword(event.target.value.slice(0, 16)); setError('') }}
                    onAnimationEnd={() => setShake(false)}
                    placeholder="Masukkan password"
                    className={`h-11 w-full rounded-lg border bg-slate-950 py-2 pl-3 pr-20 text-sm text-white outline-none transition-colors ${error ? 'border-rose-500' : 'border-slate-700 focus:border-emerald-500'} ${shake ? 'maker-pin-shake' : ''}`} />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showPassword} /></button>
                </div>
              </label>
              <p className="text-[11px] text-slate-500">8–16 karakter, minimal huruf dan angka. Simbol opsional, tanpa spasi.</p>
              {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
              {busy && <p className="text-center text-xs text-emerald-400">Memverifikasi...</p>}
              <button type="submit" data-button-kind="primary" disabled={busy || (role === 'accountant' && (!kitchenId || loadingKitchens)) || (!PASSWORD_PATTERN.test(password) && !(role === 'admin' && /^\d{8}$/.test(password)))} className="h-11 w-full rounded-lg text-sm font-semibold disabled:opacity-40">{busy ? 'Memverifikasi...' : 'Masuk'}</button>
              {role === 'admin' && <p className="text-[11px] text-amber-300">Transisi satu kali: PIN lama masih dapat digunakan untuk masuk dan langsung membuat password baru.</p>}
            </form>
          )}
        </div>
        {!role && <p className="mt-4 text-center text-xs text-slate-500">Pilih jenis akun untuk melanjutkan.</p>}
      </div>
    </main>
  )
}

function ChangePasswordScreen({ onSave }: { onSave: (password: string, confirmPassword: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!PASSWORD_PATTERN.test(password)) { setError('Password harus 8–16 karakter tanpa spasi.'); return }
    if (password !== confirm) { setError('Konfirmasi password belum sama.'); return }
    setBusy(true)
    setError('')
    try {
      await onSave(password, confirm)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password belum berhasil diganti.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mp-auth-screen flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <div className="mp-auth-card w-full max-w-md rounded-2xl border border-slate-700/70 bg-slate-900/85 p-6 shadow-xl sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">Keamanan akun</p>
        <h1 className="mt-2 text-2xl font-bold">Buat password baru</h1>
        
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-300">Password baru
            <div className="relative mt-1.5">
              <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={16} required value={password} onChange={(event) => setPassword(event.target.value.slice(0, 16))} className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 pr-20 text-sm text-white outline-none focus:border-emerald-500" />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showPassword} /></button>
            </div>
          </label>
          <label className="block text-sm font-medium text-slate-300">Ulangi password baru
            <div className="relative mt-1.5">
              <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={16} required value={confirm} onChange={(event) => setConfirm(event.target.value.slice(0, 16))} className="h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 pr-20 text-sm text-white outline-none focus:border-emerald-500" />
              <button type="button" onClick={() => setShowConfirm((value) => !value)} aria-label={showConfirm ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showConfirm} /></button>
            </div>
          </label>
          <PasswordGuidance value={password} />
          {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
          <button type="submit" data-button-kind="primary" disabled={busy || !PASSWORD_PATTERN.test(password) || confirm !== password} className="h-11 w-full rounded-lg text-sm font-semibold disabled:opacity-40">{busy ? 'Menyimpan...' : 'Simpan Password'}</button>
        </form>

      </div>
    </main>
  )
}

export default function AuthApp() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [checking, setChecking] = useState(true)
  const [view, setView] = useState<'workspace' | 'admin'>('workspace')

  useEffect(() => {
    let active = true
    const restore = async () => {
      const token = window.sessionStorage.getItem(SESSION_KEY)
      if (!token) { if (active) setChecking(false); return }
      try {
        const result = await authRequest({ action: 'session' }, token)
        if (!active) return
        if (!result.user) throw new Error('Sesi tidak valid.')
        setAuth({ token, user: result.user, mustChange: Boolean(result.must_change_credential) })
      } catch {
        window.sessionStorage.removeItem(SESSION_KEY)
      } finally {
        if (active) setChecking(false)
      }
    }
    void restore()
    return () => { active = false }
  }, [])

  const login = useCallback(async (role: 'admin' | 'accountant', kitchenId: string, password: string) => {
    const result = await authRequest({ action: 'login', role, kitchen_id: kitchenId || undefined, password })
    if (!result.access_token || !result.user) throw new Error('Respons login tidak lengkap.')
    window.sessionStorage.setItem(SESSION_KEY, result.access_token)
    setAuth({ token: result.access_token, user: result.user, mustChange: Boolean(result.must_change_credential) })
    setView('workspace')
  }, [])

  async function changePassword(password: string, confirmPassword: string) {
    if (!auth) return
    await authRequest({ action: 'change_password', new_password: password, confirm_password: confirmPassword }, auth.token)
    setAuth((current) => current ? { ...current, mustChange: false } : current)
  }

  function logout() {
    const token = auth?.token
    window.sessionStorage.removeItem(SESSION_KEY)
    setAuth(null)
    setView('workspace')
    if (token) void authRequest({ action: 'logout' }, token).catch(() => undefined)
  }

  if (checking) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">Memeriksa sesi...</main>
  }
  if (!auth) return <LoginScreen onLogin={login} />
  if (auth.mustChange) return <ChangePasswordScreen onSave={changePassword} />

  return (
    <div className="mp-app-shell min-h-screen bg-slate-950 text-white">
      <header className="mp-app-header sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-xl"><div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{auth.user.role === 'admin' ? 'Administrator' : auth.user.display_name.replace(/^Akuntan\s+/i, '')}</p>
          {auth.user.role === 'accountant' && <p className="text-[11px] uppercase tracking-wider text-slate-500">Akuntan</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {auth.user.role === 'admin' && (
            <>
              <button type="button" data-option-button="true" data-selected={view === 'workspace'} onClick={() => setView('workspace')} className="rounded-lg px-3 py-2 text-xs font-semibold">Workspace</button>
              <button type="button" data-option-button="true" data-selected={view === 'admin'} onClick={() => setView('admin')} className="rounded-lg px-3 py-2 text-xs font-semibold">Admin Panel</button>
            </>
          )}
          <button type="button" onClick={() => void logout()} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300">Keluar</button>
        </div>
      </div></header>
      {auth.user.role === 'admin' ? (
        <>
          <div className={view === 'workspace' ? '' : 'hidden'}>
            <MakerWorkspace token={auth.token} role="admin" />
          </div>
          {view === 'admin' && <div className="px-3 pb-8 sm:px-5"><AdminPanel token={auth.token} /></div>}
        </>
      ) : (
        <MakerWorkspace fixedKitchen token={auth.token} role="accountant" />
      )}
    </div>
  )
}
