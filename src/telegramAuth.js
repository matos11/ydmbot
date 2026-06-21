import { db } from './firebase.js'
import { ref, get, set, update, serverTimestamp } from 'firebase/database'
import { sanitizeKey } from './utils.js'

const STARTING_BALANCE = 100 // birr granted to brand new accounts

/**
 * Returns the raw Telegram WebApp object if the app is actually running
 * inside Telegram, otherwise null. We check for initDataUnsafe.user because
 * Telegram.WebApp can technically exist on window in odd embedding cases
 * without real init data behind it.
 */
export function getTelegramWebApp() {
  const tg = window.Telegram?.WebApp
  if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) return null
  return tg
}

/**
 * Reads the Telegram user out of initDataUnsafe. This is fine for display
 * purposes (name, username, photo) immediately on load. It is NOT
 * cryptographically verified on the client — verification of `initData`
 * (the signed string) must happen server-side / in a Cloud Function before
 * you trust it for anything money-sensitive. We still gate balance writes
 * through Firebase transactions server-side rules, same as before.
 */
export function getTelegramUser() {
  const tg = getTelegramWebApp()
  if (!tg) return null
  const u = tg.initDataUnsafe.user
  return {
    telegram_id: u.id,
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || '',
    photo_url: u.photo_url || '',
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Player'
  }
}

/**
 * Looks up (or creates) the Firebase user record for this Telegram identity.
 * Returns { playerKey, isNew, userData }.
 */
export async function syncTelegramUser(tgUser) {
  const playerKey = sanitizeKey(String(tgUser.telegram_id))
  const userRef = ref(db, `users/${playerKey}`)
  const snap = await get(userRef)

  if (snap.exists()) {
    const existing = snap.val()
    // Keep profile fields fresh (name/username/photo can change in Telegram)
    await update(userRef, {
      first_name: tgUser.first_name,
      last_name: tgUser.last_name,
      username: tgUser.username,
      photo_url: tgUser.photo_url,
      lastSeen: serverTimestamp()
    })
    return { playerKey, isNew: false, userData: existing }
  }

  const newUser = {
    name: tgUser.name,
    first_name: tgUser.first_name,
    last_name: tgUser.last_name,
    username: tgUser.username,
    photo_url: tgUser.photo_url,
    telegram_id: tgUser.telegram_id,
    phone: '',
    balance: STARTING_BALANCE,
    createdAt: serverTimestamp(),
    lastSeen: serverTimestamp()
  }
  await set(userRef, newUser)
  return { playerKey, isNew: true, userData: newUser }
}

/**
 * Persists the session the rest of the app already expects in localStorage
 * (CartelaPage / GamePage read `bingoUser` from there).
 */
export function persistSession(tgUser) {
  localStorage.setItem('bingoUser', JSON.stringify({
    name: tgUser.name,
    phone: '', // Telegram users are keyed by telegram_id, not phone
    telegram_id: tgUser.telegram_id,
    username: tgUser.username,
    photo_url: tgUser.photo_url
  }))
}