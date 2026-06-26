import { db } from './firebase.js'
import { ref, get, set, update, serverTimestamp } from 'firebase/database'
import { sanitizeKey } from './utils.js'

const STARTING_BALANCE = 100 // birr granted to brand new accounts

/**
 * Returns the raw Telegram WebApp object if the app is actually running
 * inside Telegram, otherwise null.
 */
export function getTelegramWebApp() {
  // Defensive check for Server-Side Rendering (SSR) or non-browser environments
  if (typeof window === 'undefined') return null

  const tg = window.Telegram?.WebApp
  
  // Ensure the WebApp SDK is loaded and initData contains valid user data
  if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
    console.warn("Telegram WebApp context not found. Ensure the SDK script is loaded and opened inside Telegram via a WebApp button.")
    return null
  }
  
  return tg
}

/**
 * Reads the Telegram user out of initDataUnsafe for immediate display purposes.
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
 * Merges fresh Telegram metadata with persistent server fields (like balance and phone).
 */
export async function syncTelegramUser(tgUser) {
  if (!tgUser) return null

  const playerKey = sanitizeKey(String(tgUser.telegram_id))
  const userRef = ref(db, `users/${playerKey}`)
  const snap = await get(userRef)

  if (snap.exists()) {
    const existing = snap.val()
    
    // Updates profile metadata while preserving critical server-side fields like balance
    const updatedFields = {
      first_name: tgUser.first_name || existing.first_name || '',
      last_name: tgUser.last_name || existing.last_name || '',
      username: tgUser.username || existing.username || '',
      photo_url: tgUser.photo_url || existing.photo_url || '',
      lastSeen: serverTimestamp()
    }
    
    await update(userRef, updatedFields)
    
    // Return the fresh combination of persistent DB fields + updated metadata
    return { 
      playerKey, 
      isNew: false, 
      userData: { ...existing, ...updatedFields } 
    }
  }

  // Create a brand new record if user doesn't exist in the database
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
 * Persists the session in localStorage using the authoritative data 
 * retrieved from the Firebase Database instead of relying purely on Telegram metadata.
 */
export function persistSession(dbUserData) {
  if (!dbUserData) return

  const fallbackName = [dbUserData.first_name, dbUserData.last_name].filter(Boolean).join(' ') || dbUserData.username || 'Player'
  
  localStorage.setItem('bingoUser', JSON.stringify({
    name: dbUserData.name || fallbackName,
    phone: dbUserData.phone || '', 
    telegram_id: dbUserData.telegram_id,
    username: dbUserData.username || '',
    photo_url: dbUserData.photo_url || '',
    balance: dbUserData.balance ?? STARTING_BALANCE // Standardizes fallback balance injection
  }))
}