import { useCallback, useEffect, useState } from 'react'
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

async function authRequest(body: Record<string, unknown>, token?: string): Promise<AuthResponse> {
  const { data, error } = await supabase.functions.invoke('maker-auth', {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  })
  if (error || data?.error) {
    throw new Error(data?.error ?? error?.message ?? 'Permintaan autentikasi gagal.')
  }
  return data as AuthResponse
}

function LoginScreen({ onLogin }: { onLogin: (identifier: string, password: string) => Promise<void> }) {
  const [role, setRole] = useState<'admin' | 'accountant'>('admin')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onLogin(role === 'admin' ? 'admin@internal.com' : identifier.trim().toLowerCase(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login gagal. Periksa kembali kredensial.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
      <div className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900/90 p-6 shadow-2xl sm:p-8">
        <div className="mb-7 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-emerald-700/60 bg-emerald-950/50 text-xl font-black text-emerald-300">M</div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400">Maker Pencairan</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Masuk ke akun</h1>
          <p className="mt-2 text-sm text-slate-400">Gunakan kredensial yang diberikan oleh Admin.</p>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-slate-700 bg-slate-950 p-1">
          <button type="button" data-option-button="true" data-selected={role === 'admin'} onClick={() => { setRole('admin'); setError('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Admin</button>
          <button type="button" data-option-button="true" data-selected={role === 'accountant'} onClick={() => { setRole('accountant'); setError('') }} className="rounded-lg px-3 py-2.5 text-sm font-semibold">Accountant</button>
        </div>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {role === 'accountant' && (
            <label className="block text-sm font-medium text-slate-300">Email login
              <input type="email" autoComplete="username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="akuntan.namadapur@internal.com" className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500" />
            </label>
          )}
          <label className="block text-sm font-medium text-slate-300">{role === 'admin' ? 'PIN Admin' : 'Password'}
            <input type="password" autoComplete="current-password" required minLength={role === 'admin' ? 8 : 1} maxLength={256} inputMode={role === 'admin' ? 'numeric' : undefined} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={role === 'admin' ? 'Masukkan PIN Admin' : 'Masukkan password'} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
          <button type="submit" data-button-kind="primary" disabled={busy || !password || (role === 'accountant' && !identifier.trim())} className="h-11 w-full rounded-lg text-sm font-semibold disabled:opacity-40">{busy ? 'Memeriksa...' : 'Masuk'}</button>
        </form>
        <p className="mt-5 text-center text-xs leading-5 text-slate-500">Jika lupa password, hubungi Admin untuk reset akses. Sistem tidak mengirim notifikasi otomatis.</p>
      </div>
    </main>
  )
}

function ChangePasswordScreen({ onSave, user }: { onSave: (password: string) => Promise<void>; user: MakerUser }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (password.length < 12) { setError('Password minimal 12 karakter.'); return }
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
        <p className="mt-2 text-sm leading-6 text-slate-400">Akun {user.display_name} harus menggunakan password pribadi sebelum melanjutkan.</p>
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
          <label className="block text-sm font-medium text-slate-300">Password baru
            <input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500" />
          </label>
          <label className="block text-sm font-medium text-slate-300">Ulangi password baru
            <input type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none focus:border-emerald-500" />
          </label>
          {error && <p role="alert" className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
          <button type="submit" data-button-kind="primary" disabled={busy || password.length < 12 || confirm !== password} className="h-11 w-full rounded-lg text-sm font-semibold disabled:opacity-40">{busy ? 'Menyimpan...' : 'Simpan password baru'}</button>
        </form>
        <p className="mt-4 text-xs leading-5 text-slate-500">Simpan password baru di Bitwarden. Admin tidak dapat melihat password yang sudah kamu buat.</p>
      </div>
    </main>
  )
}

export default function AuthApp() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [checking, setChecking] = useState(true)
  const [view, setView] = useState<'workspace' | 'admin'>('workspace')
  const [error, setError] = useState('')

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

  async function logout() {
    if (auth) {
      try { await authRequest({ action: 'logout' }, auth.token) } catch { /* Clear local session even if network is unavailable. */ }
    }
    window.sessionStorage.removeItem(SESSION_KEY)
    setAuth(null)
    setView('workspace')
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
          <p className="text-sm font-semibold text-white">{auth.user.display_name}</p>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">{auth.user.role === 'admin' ? 'Administrator' : 'Accountant'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {auth.user.role === 'admin' && (
            <>
              <button type="button" data-option-button="true" data-selected={view === 'workspace'} onClick={() => setView('workspace')} className="rounded-lg px-3 py-2 text-xs font-semibold">Workspace</button>
              <button type="button" data-option-button="true" data-selected={view === 'admin'} onClick={() => setView('admin')} className="rounded-lg px-3 py-2 text-xs font-semibold">Panel Admin</button>
            </>
          )}
          <button type="button" onClick={() => void logout()} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300">Keluar</button>
        </div>
      </div>
      {error && <p className="mx-auto max-w-6xl px-4 text-sm text-rose-300">{error}</p>}
      {auth.user.role === 'admin' && view === 'admin'
        ? <div className="px-3 pb-8 sm:px-5"><AdminPanel token={auth.token} /></div>
        : <MakerWorkspace />}
    </div>
  )
}
