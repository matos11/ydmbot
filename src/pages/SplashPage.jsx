import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getTelegramWebApp, getTelegramUser, syncTelegramUser, persistSession } from '../telegramAuth.js'

const MIN_SPLASH_MS = 900 // keep splash visible briefly even on instant auth, avoids a jarring flash

export default function SplashPage() {
  const navigate = useNavigate()
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('Connecting to Telegram...')
  const [errorState, setErrorState] = useState(null) // null | 'no-telegram' | 'auth-failed'
  const startedAt = useRef(Date.now())
  const progressTimer = useRef(null)

  useEffect(() => {
    // Animate the loading bar smoothly toward ~90% while real work happens,
    // then we snap it to 100% once auth actually resolves.
    progressTimer.current = setInterval(() => {
      setProgress(p => (p < 90 ? p + (90 - p) * 0.12 + 0.5 : p))
    }, 80)

    runAuth()

    return () => clearInterval(progressTimer.current)
  }, [])

  async function finishAndGo(path) {
    setProgress(100)
    clearInterval(progressTimer.current)
    const elapsed = Date.now() - startedAt.current
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed)
    setTimeout(() => navigate(path), wait)
  }

  async function runAuth() {
    const tg = getTelegramWebApp()

    if (!tg) {
      clearInterval(progressTimer.current)
      setProgress(100)
      setErrorState('no-telegram')
      return
    }

    try {
      tg.ready()
      tg.expand()
    } catch (e) { /* non-fatal */ }

    const tgUser = getTelegramUser()
    if (!tgUser || !tgUser.telegram_id) {
      clearInterval(progressTimer.current)
      setProgress(100)
      setErrorState('auth-failed')
      return
    }

    setStatusText('Checking your account...')

    try {
      // Synchronize with Firebase and unpack BOTH the novelty flag and the true database profile
      const { isNew, userData } = await syncTelegramUser(tgUser)
      
      // Store the official Firebase-backed dataset (maintains correct balance/fields)
      persistSession(userData)
      
      setStatusText(isNew ? 'Welcome to YDM Bingo!' : `Welcome back, ${userData.name || tgUser.name}!`)
      await finishAndGo('/cartela')
    } catch (e) {
      console.error('Telegram auth sync failed:', e)
      clearInterval(progressTimer.current)
      setProgress(100)
      setErrorState('auth-failed')
    }
  }

  function retry() {
    setErrorState(null)
    setProgress(0)
    startedAt.current = Date.now()
    progressTimer.current = setInterval(() => {
      setProgress(p => (p < 90 ? p + (90 - p) * 0.12 + 0.5 : p))
    }, 80)
    runAuth()
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.logoBlock}>
        <div style={styles.logoMark}>YDM</div>
        <div style={styles.logoSub}>BINGO</div>
      </div>

      {!errorState && (
        <div style={styles.loadingBlock}>
          <div style={styles.barTrack}>
            <div style={{ ...styles.barFill, width: `${progress}%` }} />
          </div>
          <div style={styles.statusText}>{statusText}</div>
        </div>
      )}

      {errorState === 'no-telegram' && (
        <div style={styles.errorBlock}>
          <div style={styles.errorIcon}>📱</div>
          <div style={styles.errorTitle}>Open in Telegram</div>
          <div style={styles.errorMsg}>
            YDM Bingo runs inside Telegram. Please open this game from the
            Telegram bot or menu button to play.
          </div>
        </div>
      )}

      {errorState === 'auth-failed' && (
        <div style={styles.errorBlock}>
          <div style={styles.errorIcon}>⚠️</div>
          <div style={styles.errorTitle}>Couldn't verify your account</div>
          <div style={styles.errorMsg}>
            Something went wrong while connecting to Telegram. Please try again.
          </div>
          <button style={styles.retryBtn} onClick={retry}>Try Again</button>
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: {
    minHeight: '100vh',
    background: '#000',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontFamily: "'Nunito', 'Poppins', sans-serif",
    padding: '24px',
    textAlign: 'center'
  },
  logoBlock: {
    marginBottom: '56px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center'
  },
  logoMark: {
    fontFamily: "'Space Mono', monospace",
    fontSize: '42px',
    fontWeight: 700,
    letterSpacing: '4px',
    color: '#4caf50',
    textShadow: '0 0 24px rgba(76,175,80,0.45)'
  },
  logoSub: {
    fontSize: '14px',
    letterSpacing: '6px',
    color: '#888',
    marginTop: '6px'
  },
  loadingBlock: {
    width: '220px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '14px'
  },
  barTrack: {
    width: '100%',
    height: '6px',
    borderRadius: '4px',
    background: '#1c1c1c',
    overflow: 'hidden'
  },
  barFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #4caf50, #8bc34a)',
    borderRadius: '4px',
    transition: 'width 0.15s ease-out'
  },
  statusText: {
    fontSize: '13px',
    color: '#999',
    fontWeight: 600
  },
  errorBlock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '10px',
    maxWidth: '320px'
  },
  errorIcon: { fontSize: '40px' },
  errorTitle: { fontSize: '17px', fontWeight: 700 },
  errorMsg: { fontSize: '13px', color: '#999', lineHeight: '1.5' },
  retryBtn: {
    marginTop: '12px',
    background: '#4caf50',
    color: '#000',
    border: 'none',
    borderRadius: '6px',
    padding: '10px 22px',
    fontWeight: 700,
    fontSize: '14px',
    cursor: 'pointer'
  }
}