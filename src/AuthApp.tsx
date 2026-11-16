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
function LoginScreen({ onLogin }: { onLogin: (identifier: string, password: string) => Promise<void> }) {
  const [role, setRole] = useState<'admin' | 'accountant'>('admin')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pinError, setPinError] = useState(false)
  const [shake, setShake] = useState(false)
  const pinRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)

  async function submit(nextPassword = password, nextIdentifier = identifier, selectedRole = role) {
    if (selectedRole === 'admin' && !/^\d{8}$/.test(nextPassword)) {
      setPinError(true)
      setError('PIN Admin harus tepat 8 digit.')
      pinRef.current?.focus()
      return
    }
    if (selectedRole === 'accountant' && (!PASSWORD_PATTERN.test(nextPassword) || !nextIdentifier.trim())) {
      setError('Password harus 8–16 karakter tanpa spasi.')
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await onLogin(selectedRole === 'admin' ? 'admin@internal.com' : nextIdentifier.trim().toLowerCase(), nextPassword)
    } catch (err) {
      const status = (err as Error & { status?: number })?.status
      const message = err instanceof Error ? err.message : 'Login gagal. Periksa kembali kredensial.'
      if (selectedRole === 'admin' && status === 401) {
        setPassword('')
        setPinError(true)
        setError('PIN salah. Silakan coba lagi.')
        setShake(false)
        requestAnimationFrame(() => {
          setShake(true)
          pinRef.current?.focus()
        })
      } else {
        setError(message)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const isAdmin = role === 'admin'
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <div className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900/90 p-6 shadow-2xl sm:p-8">
        <div className="mb-7 text-center">
          <p className="text-lg font-bold tracking-tight text-white">Maker Pencairan</p>
          <h1 className="mt-1 text-xs font-semibold uppercase tracking-[0.24em] text-emerald-400">LOGIN</h1>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-slate-700 bg-slate-950 p-1">
          <button type="button" data-option-button="true" data-selected={isAdmin} onClick={() => { setRole('admin'); setError(''); setPinError(false); setPassword('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Admin</button>
          <button type="button" data-option-button="true" data-selected={!isAdmin} onClick={() => { setRole('accountant'); setError(''); setPinError(false); setPassword('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Akuntan</button>
        </div>
        <div className="space-y-4">
          {!isAdmin && (
            <label className="block text-sm font-medium text-slate-300">Email
              <input type="email" autoComplete="username" required value={identifier} onChange={(event) => { const value = event.target.value; setIdentifier(value); if (PASSWORD_PATTERN.test(password)) void submit(password, value, 'accountant') }} placeholder="akuntan.namadapur@internal.com" className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500" />
            </label>
          )}
          <label className="block text-sm font-medium text-slate-300">{isAdmin ? 'PIN Admin' : 'Password'}
            <div className="relative mt-1.5">
              <input
                ref={isAdmin ? pinRef : undefined}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={isAdmin ? 8 : 16}
                pattern={isAdmin ? '[0-9]{8}' : undefined}
                inputMode={isAdmin ? 'numeric' : 'text'}
                value={password}
                onChange={(event) => {
                  const value = isAdmin ? event.target.value.replace(/\D/g, '').slice(0, 8) : event.target.value.replace(/\s/g, '').slice(0, 16)
                  setPassword(value)
                  setPinError(false)
                  setError('')
                  if (isAdmin && value.length === 8) void submit(value, '', 'admin')
                  if (!isAdmin && PASSWORD_PATTERN.test(value)) void submit(value, identifier, 'accountant')
                }}
                onAnimationEnd={() => setShake(false)}
                placeholder={isAdmin ? 'Masukkan 8 digit PIN' : 'Masukkan password'}
                className={`h-11 w-full rounded-lg border bg-slate-950 py-2 pl-3 pr-20 text-sm text-white outline-none transition-colors ${pinError ? 'border-rose-500 ring-1 ring-rose-500/50' : 'border-slate-700 focus:border-emerald-500'} ${shake ? 'maker-pin-shake' : ''}`}
              />
              <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'} className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-md border-0 text-slate-300 shadow-none"><EyeIcon visible={showPassword} /></button>
            </div>
            {isAdmin && <span className="mt-1 block text-[11px] text-slate-500">{password.length}/8 digit</span>}
          </label>
          {!isAdmin && <p className="text-[11px] text-slate-500">8–16 karakter, minimal huruf dan angka. Simbol opsional, tanpa spasi.</p>}
          {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
          {busy && <p className="text-center text-xs text-emerald-400">Memverifikasi...</p>}
        </div>
      </div>
    </main>
  )
}

function ChangePasswordScreen({ onSave, user }: { onSave: (password: string) => Promise<void>; user: MakerUser }) {
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
      await onSave(password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password belum berhasil diganti.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <div className="w-full max-w-md rounded-2xl border border-amber-700/50 bg-slate-900 p-6 shadow-2xl sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Keamanan akun</p>
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

  const login = useCallback(async (identifier: string, password: string) => {
    const result = await authRequest({ action: 'login', identifier, password })
    if (!result.access_token || !result.user) throw new Error('Respons login tidak lengkap.')
    window.sessionStorage.setItem(SESSION_KEY, result.access_token)
    setAuth({ token: result.access_token, user: result.user, mustChange: Boolean(result.must_change_credential) })
    setView('workspace')
  }, [])

  async function changePassword(password: string) {
    if (!auth) return
    await authRequest({ action: 'change_password', new_password: password }, auth.token)
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
  if (auth.mustChange) return <ChangePasswordScreen user={auth.user} onSave={changePassword} />

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{auth.user.role === 'accountant' ? auth.user.display_name.replace(/^Akuntan\\s+/i, '') : auth.user.display_name}</p>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">{auth.user.role === 'admin' ? 'Administrator' : 'Akuntan'}</p>
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
      </div>
      {auth.user.role === 'admin' && view === 'admin'
        ? <div className="px-3 pb-8 sm:px-5"><AdminPanel token={auth.token} /></div>
        : <MakerWorkspace fixedKitchen={auth.user.role === 'accountant'} />}
    </div>
  )
}
