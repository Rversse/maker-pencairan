import { supabase } from '../lib/supabase'

const MAKER_ACCOUNTS = {
  admin: 'maker-admin@internal.local',
  akuntan: 'maker-akuntan@internal.local'
} as const

export type MakerAccount = keyof typeof MAKER_ACCOUNTS

export async function loginMaker(account: MakerAccount, password: string) {
  // Complete the initial auth-state read before starting a new login.
  // This prevents a slow getSession() started by App.tsx from resolving
  // after signInWithPassword() and overwriting the newly-created session.
  await supabase.auth.getSession()

  const { data, error } = await supabase.auth.signInWithPassword({
    email: MAKER_ACCOUNTS[account],
    password
  })

  if (error || !data.session) {
    throw new Error(error?.message || 'Password salah')
  }

  return data.session
}

export async function logoutMaker() {
  await supabase.auth.signOut()
}
