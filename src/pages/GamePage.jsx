import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { db } from '../firebase.js'
import {
  ref, onValue, off, get, set, push, update, remove,
  serverTimestamp, runTransaction, onDisconnect, onChildAdded
} from 'firebase/database'
import {
  colClass, letter, bubClass, sanitizeKey,
  PATTERNS, playNum, playWinnerSound, startFireworks, REDIRECT_SEC
} from '../utils.js'

const COLS = ['b', 'i', 'n', 'g', 'o']

// Build a flat 25-cell representation of a card once, instead of re-deriving
// the b/i/n/g/o column mapping on every render / every drawn ball.
function buildFlatCard(card) {
  const cells = []
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c
      if (idx === 12) {
        cells.push({ idx, val: 'FREE', isFree: true })
        continue
      }
      const colArr = card[COLS[c]]
      const raw = c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r]
      cells.push({ idx, val: parseInt(raw), isFree: false })
    }
  }
  return cells
}

function shuffledBalls() {
  const arr = Array.from({ length: 75 }, (_, i) => i + 1)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ── Shared animation styles (kept local so this file stays self-contained) ─
function GameAnimStyles() {
  return (
    <style>{`
      @keyframes ballPopIn {
        0%   { transform: scale(0.3) rotate(-8deg); opacity: 0; }
        55%  { transform: scale(1.15) rotate(3deg); opacity: 1; }
        75%  { transform: scale(0.94) rotate(-1deg); }
        100% { transform: scale(1) rotate(0deg); }
      }
      .hbub.pop-anim { animation: ballPopIn 0.5s cubic-bezier(.34,1.56,.64,1) both; }

      @keyframes cellCalledPulse {
        0%   { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,184,0,0.65); }
        40%  { transform: scale(1.25); box-shadow: 0 0 0 6px rgba(255,184,0,0.25); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,184,0,0); }
      }
      .bnum.just-called { animation: cellCalledPulse 0.8s ease-out; }

      @keyframes softFadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .starting-banner {
        animation: softFadeIn 0.3s ease-out both;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        background: rgba(255,184,0,0.1);
        border: 1px solid rgba(255,184,0,0.35);
        color: #FFB800; font-weight: 800; font-size: 12px;
        padding: 8px 10px; border-radius: 8px; margin-bottom: 8px;
      }
      .sync-badge {
        position: fixed; top: 10px; right: 10px; z-index: 40;
        background: rgba(0,212,255,0.15); border: 1px solid rgba(0,212,255,0.4);
        color: #00d4ff; font-size: 11px; font-weight: 700;
        padding: 5px 10px; border-radius: 20px;
        animation: softFadeIn 0.25s ease-out both;
      }
    `}</style>
  )
}

// ── YDM Splash Loading Screen ──────────────────────────────
function LoadingScreen({ label }) {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #0b071e 0%, #060310 100%)',
      color: '#fff',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    }}>
      <div style={{
        fontSize: '42px',
        fontWeight: '900',
        letterSpacing: '4px',
        color: '#FFB800',
        textShadow: '0 0 20px rgba(255,184,0,0.4)',
        marginBottom: '5px'
      }}>
        YDM BINGO
      </div>
      <div style={{
        fontSize: '11px',
        letterSpacing: '5px',
        color: '#00d4ff',
        fontWeight: '700',
        textTransform: 'uppercase',
        marginBottom: '40px'
      }}>
        {label || 'ጨዋታው እየተጀመረ ነው'}
      </div>
      <div style={{
        width: '36px',
        height: '36px',
        border: '3px solid rgba(255,184,0,0.15)',
        borderTop: '3px solid #FFB800',
        borderRadius: '50%',
        animation: 'spin .7s linear infinite'
      }}></div>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

// ── Error Screen ──────────────────────────────────────────
function ErrorScreen({ message, onRetry }) {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#060310',
      color: '#fff',
      fontFamily: 'sans-serif',
      padding: '20px'
    }}>
      <div style={{ marginBottom: '20px', fontSize: '40px' }}>⚠️</div>
      <h2 style={{ marginBottom: '10px', fontSize: '20px', color: '#ff3366' }}>ስህተት ተከስቷል</h2>
      <p style={{ marginBottom: '25px', color: '#7c8ca0', fontSize: '13px', textAlign: 'center' }}>
        {message}
      </p>
      <button
        onClick={onRetry}
        style={{
          padding: '10px 24px',
          background: '#FFB800',
          color: '#000',
          border: 'none',
          borderRadius: '6px',
          fontWeight: '800',
          cursor: 'pointer',
          fontSize: '14px'
        }}
      >
        🔄 ድጋሚ ሞክር
      </button>
    </div>
  )
}

// ── Winner overlay card table ─────────────────────────────
const WoTable = React.memo(function WoTable({ flat, pi, drawnSet }) {
  const rows = []
  for (let r = 0; r < 5; r++) {
    const cells = []
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c
      const v = flat[idx] || ''
      let cls = ''
      if (v === 'FREE' || idx === 12) cls = 'wc-free'
      else if (pi && pi.includes(idx)) cls = 'wc-win'
      else if (drawnSet.has(parseInt(v))) cls = 'wc-called'
      cells.push(<td key={c} className={cls}>{v === 'FREE' ? 'F' : v}</td>)
    }
    rows.push(<tr key={r}>{cells}</tr>)
  }
  return (
    <table className="wo-tbl">
      <thead><tr><th>B</th><th>I</th><th>N</th><th>G</th><th>O</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
  )
})

// ── Bingo card table ──────────────────────────────────────
const BingoCard = React.memo(function BingoCard({
  flatCells, cardNum, ci, drawnSet, markedSet, autoMode, gameActive, gameEnded,
  onManualMark, onClaim, winBlink, claimReady
}) {
  const rows = []
  for (let r = 0; r < 5; r++) {
    const cells = []
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c
      if (idx === 12) {
        cells.push(<td key={c} className="free" data-val="FREE">F</td>)
        continue
      }
      const cell = flatCells[idx]
      const val = cell.val
      const isCalled = drawnSet.has(val)
      const isMarked = markedSet.has(idx)
      let tdClass = ''
      if (winBlink && winBlink.includes(idx)) {
        tdClass = 'win-blink'
      } else if (isMarked) {
        tdClass = `marked ${autoMode ? 'auto-marked' : 'manual-marked'}`
      } else if (isCalled && !autoMode) {
        tdClass = 'callable'
      }
      const handleClick = (!autoMode && isCalled && !isMarked && gameActive && !gameEnded)
        ? () => onManualMark(ci, idx, val)
        : undefined
      cells.push(
        <td key={c} className={tdClass} data-val={val} data-idx={idx} onClick={handleClick}>{val}</td>
      )
    }
    rows.push(<tr key={r}>{cells}</tr>)
  }
  return (
    <div className="card-block" id={`cb${ci}`}>
      <table className="ct" id={`ct${ci}`}>
        <thead>
          <tr>{COLS.map(c => <th key={c} className={c}>{c.toUpperCase()}</th>)}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      <div className="card-lbl">Card {cardNum}</div>
      <button
        className={`claim-btn${claimReady ? ' ready' : ''}`}
        onClick={() => onClaim(ci)}
        disabled={autoMode || !claimReady || gameEnded}
      >
        {autoMode
          ? (claimReady ? '🎉 BINGO!' : 'Auto ✓')
          : (claimReady ? '🎉 CLAIM BINGO!' : 'BINGO')
        }
      </button>
    </div>
  )
})

// ── Winner Overlay ────────────────────────────────────────
function WinnerOverlay({ show, winners, playerKey, currentPrize, drawnSet, cdSec }) {
  const canvasRef = useRef(null)
  const fireworksStarted = useRef(false)

  useEffect(() => {
    if (show && canvasRef.current && !fireworksStarted.current) {
      fireworksStarted.current = true
      startFireworks(canvasRef.current)
    }
  }, [show])

  if (!winners || !winners.length) return null

  const total = winners.length
  const split = Math.floor(currentPrize / total)
  const myWins = winners.filter(w => w.playerKey === playerKey)
  const iWon = myWins.length > 0
  const myShare = split * myWins.length

  const first = winners[0]
  const fPhone = first.phone || ''
  const maskedFirst = fPhone.length > 4 ? fPhone.slice(0, 2) + '*' + fPhone.slice(-4) : fPhone
  const otherCount = total - 1

  return (
    <div className={`winner-overlay${show ? ' show' : ''}`}>
      <canvas id="celebCanvas" ref={canvasRef} />
      <div className="wo-darkbg" />
      <div className="wo-content">
        <div className="wo-header">
          <div className="wo-bingo-line">🎉 BINGO!</div>

          {iWon && (
            <div className="wo-you-badge show">
              <span className="wo-you-crown">👑</span>
              <span className="wo-you-txt">YOU ARE A WINNER!</span>
              <span className="wo-you-prize">{myShare} ETB</span>
            </div>
          )}

          <div className="wo-names-line">
            <span className={`wo-name-chip${first.playerKey === playerKey ? ' mine' : ''}`}>
              {first.name || 'Anonymous'} ({maskedFirst})
            </span>
            {otherCount === 1 && (() => {
              const sec = winners[1]
              const sPhone = sec.phone || ''
              const maskedSec = sPhone.length > 4 ? sPhone.slice(0, 2) + '*' + sPhone.slice(-4) : sPhone
              return (
                <>
                  <span className="wo-and-others">and</span>
                  <span className={`wo-name-chip${sec.playerKey === playerKey ? ' mine' : ''}`}>
                    {sec.name || 'Anonymous'} ({maskedSec})
                  </span>
                  <span className="wo-won-txt">won!</span>
                </>
              )
            })()}
            {otherCount > 1 && <span className="wo-and-others">and {otherCount} others won!</span>}
            {otherCount === 0 && <span className="wo-won-txt">won!</span>}
          </div>

          <div className="wo-countdown-row">
            <div className="wo-countdown">{cdSec}</div>
            <div className="wo-cd-unit">seconds</div>
          </div>
        </div>

        <div className="wo-scroll">
          {total > 1 && (
            <div className="wo-split-info">
              <strong>{total}</strong> winners &nbsp;·&nbsp; Prize split: <strong>{split} ETB</strong> each
            </div>
          )}
          {winners.map((w, i) => {
            const isMe = w.playerKey === playerKey
            const ph = w.phone || 'N/A'
            const masked = ph.length > 6 ? ph.slice(0, 3) + '·'.repeat(Math.max(0, ph.length - 6)) + ph.slice(-3) : ph
            return (
              <div key={i} className={`wo-card-block${isMe ? ' is-me' : ''}`}>
                <div className="wo-card-top">
                  <div>
                    <div className="wo-card-name">
                      {w.name || 'Anonymous'}
                      {isMe && <span className="wo-me-tag">YOU</span>}
                    </div>
                    <div className="wo-card-phone">{masked}</div>
                  </div>
                  <div className="wo-card-right">
                    <div className="wo-prize-amt">{split} ETB</div>
                    <div className="wo-prize-lbl">Prize</div>
                  </div>
                </div>
                <div className="wo-card-meta">
                  <div className="wo-meta-pill">Card <strong>#{w.cardNum || '?'}</strong></div>
                  <div className="wo-pattern-badge">{w.pattern || '?'}</div>
                </div>
                <WoTable flat={w.cardFull || []} pi={w.patternIndices || []} drawnSet={drawnSet} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function GamePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const forceSpec = searchParams.get('spectator') === 'true'

  // ── One-time snapshot of localStorage / URL data ─────────────────────
  // NOTE: previously this was plain code in the component body, which meant
  // JSON.parse(localStorage...) ran fresh (new object identities) on every
  // single render — defeating memoization everywhere downstream and doing
  // pointless work on every ball draw. useState's lazy initializer runs
  // exactly once, guaranteed.
  const [initial] = useState(() => {
    let user = {}
    try { user = JSON.parse(localStorage.getItem('bingoUser') || '{}') } catch (e) {}
    let rawCards = null
    try { rawCards = JSON.parse(localStorage.getItem('selectedCartelas') || 'null') } catch (e) {}

    const urlPlayers = searchParams.get('players') || '0'
    const urlBet = searchParams.get('bet') || '10'
    const urlDerash = searchParams.get('derash') || '0'

    const cards = rawCards ? (Array.isArray(rawCards) ? rawCards : [rawCards]) : null
    const cardNums = cards ? cards.map(c => c.id) : []
    const userKey = (user.telegram_id || user.phone || '').toString()
    const playerKey = sanitizeKey(userKey)

    return {
      user, cards, cardNums, playerKey,
      stakeAmt: urlBet,
      urlPlayers: parseInt(urlPlayers),
      urlDerash: parseInt(urlDerash),
      isSpectator: !cards || cards.length === 0
    }
  })

  const { user, cards, cardNums, playerKey, stakeAmt, isSpectator } = initial

  // Precompute flat card layouts + value→index maps ONCE per card set,
  // instead of re-deriving the b/i/n/g/o column mapping on every render
  // and on every single ball draw for every card.
  const cardLookups = useMemo(
    () => (cards ? cards.map(buildFlatCard) : []),
    [cards]
  )
  const cardValueMaps = useMemo(
    () => cardLookups.map(flat => {
      const m = new Map()
      flat.forEach(cell => { if (!cell.isFree) m.set(cell.val, cell.idx) })
      return m
    }),
    [cardLookups]
  )

  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [drawn, setDrawn] = useState([])
  const [isMuted, setIsMuted] = useState(true)
  const [autoMode, setAutoMode] = useState(false)

  const [currentPrize, setCurrentPrize] = useState(initial.urlDerash)
  const [playerCount, setPlayerCount] = useState(initial.urlPlayers)
  const [gameNum, setGameNum] = useState('--')
  const [gameId, setGameId] = useState('LOADING...')
  const [calledCount, setCalledCount] = useState('0/75')
  const [histBalls, setHistBalls] = useState([])
  const [justCalled, setJustCalled] = useState(null)

  const [markedSets, setMarkedSets] = useState(() => cards ? cards.map(() => new Set([12])) : [])
  const [winBlinks, setWinBlinks] = useState(() => cards ? cards.map(() => null) : [])
  const [claimReady, setClaimReady] = useState(() => cards ? cards.map(() => false) : [])

  const [gameActive, setGameActive] = useState(false)
  const [gameEnded, setGameEnded] = useState(false)
  const [gameStarted, setGameStarted] = useState(false)
  const [preGameCountdown, setPreGameCountdown] = useState(null)
  const [showStartTransition, setShowStartTransition] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)

  const [overlayShown, setOverlayShown] = useState(false)
  const [winnersList, setWinnersList] = useState([])
  const [overlayPrize, setOverlayPrize] = useState(0)
  const [cdSec, setCdSec] = useState(REDIRECT_SEC)

  // O(1) membership testing instead of `.includes()` scans (was O(n) per
  // cell, per card, on every render — noticeable once dozens of numbers
  // have been drawn).
  const drawnSet = useMemo(() => new Set(drawn), [drawn])

  const cleanupDoneRef = useRef(false)
  const iAmTheEnderRef = useRef(false)
  const overlayShownRef = useRef(false)
  const gameEndedRef = useRef(false)
  const gameActiveRef = useRef(false)
  const gameStartedRef = useRef(false)
  const drawnRef = useRef([])
  const drawnSetRef = useRef(new Set())
  const markedSetsRef = useRef(markedSets)
  const autoModeRef = useRef(false)
  const autoTriggered = useRef({})
  const cdTimerRef = useRef(null)
  const syncTickerRef = useRef(null)
  const drawLoopRef = useRef(null)
  const gameIdRef = useRef(null)
  const reconnectKeyRef = useRef(null)
  const ballsToDrawRef = useRef(null)
  const startAttemptInFlightRef = useRef(false)
  const startTransitionTimerRef = useRef(null)

  useEffect(() => { drawnRef.current = drawn; drawnSetRef.current = drawnSet }, [drawn, drawnSet])
  useEffect(() => { markedSetsRef.current = markedSets }, [markedSets])
  useEffect(() => { autoModeRef.current = autoMode }, [autoMode])
  useEffect(() => { gameEndedRef.current = gameEnded }, [gameEnded])
  useEffect(() => { gameActiveRef.current = gameActive }, [gameActive])
  useEffect(() => { gameStartedRef.current = gameStarted }, [gameStarted])

  useEffect(() => {
    const unlock = () => { try { new (window.AudioContext || window.webkitAudioContext)() } catch (e) {} }
    document.addEventListener('touchstart', unlock, { once: true })
    document.addEventListener('click', unlock, { once: true })
    return () => {
      document.removeEventListener('touchstart', unlock)
      document.removeEventListener('click', unlock)
    }
  }, [])

  // ── Reconnect-state persistence ───────────────────────────────────────
  // FIX: previously RECONNECT_KEY was built from `gameId` state, but every
  // listener that calls persistState()/restoreStateFromStorage() lives
  // inside the mount-once useEffect below, so it closed over `gameId` as it
  // was AT MOUNT TIME ("LOADING...") forever — the real game id was never
  // used, and there was no check binding a saved snapshot to the specific
  // game/player it belonged to. That is exactly the kind of cross-game
  // contamination bug that's easy to reintroduce. Fixed by keying off a ref
  // that's set once the real game id is known, and by storing/validating
  // both gameId and playerKey inside the saved payload itself.
  function setReconnectKey(realGameId) {
    gameIdRef.current = realGameId
    reconnectKeyRef.current = `ydm_gamestate_${realGameId}_${playerKey}`
  }

  function persistState(newDrawn, newMarked) {
    if (gameEndedRef.current || isSpectator || forceSpec || !cards || !reconnectKeyRef.current) return
    try {
      localStorage.setItem(reconnectKeyRef.current, JSON.stringify({
        gameId: gameIdRef.current,
        playerKey,
        drawn: newDrawn || drawnRef.current,
        markedSets: (newMarked || markedSetsRef.current).map(s => [...s]),
        autoTriggered: autoTriggered.current,
        gameStarted: gameStartedRef.current,
        ts: Date.now()
      }))
    } catch (e) {}
  }

  function restoreStateFromStorage() {
    if (isSpectator || forceSpec || !cards || !reconnectKeyRef.current) return false
    try {
      const raw = localStorage.getItem(reconnectKeyRef.current)
      if (!raw) return false
      const saved = JSON.parse(raw)
      if (Date.now() - saved.ts > 7200000) { localStorage.removeItem(reconnectKeyRef.current); return false }
      // Only trust a saved snapshot if it actually belongs to this game + player.
      if (saved.gameId !== gameIdRef.current || saved.playerKey !== playerKey) return false
      if (saved.markedSets && saved.markedSets.length === cards.length) {
        const restored = saved.markedSets.map(arr => new Set(arr))
        setMarkedSets(restored)
        markedSetsRef.current = restored
      }
      if (saved.autoTriggered) autoTriggered.current = saved.autoTriggered
      return true
    } catch (e) { return false }
  }

  function updateHistFrom(newDrawn) {
    const last5 = [...newDrawn].reverse().slice(0, 5)
    setHistBalls(last5)
    setCalledCount(`${newDrawn.length}/75`)
  }

  function recomputeClaimReady(newMarked) {
    if (!cards) return
    const newReady = newMarked.map(ms => !!PATTERNS.find(p => p.i.every(i => ms.has(i))))
    setClaimReady(newReady)
    return newReady
  }

  function triggerAutoBingo(ci, win, newMarked) {
    if (autoTriggered.current[ci]) return
    autoTriggered.current[ci] = true
    setWinBlinks(prev => {
      const next = [...prev]
      next[ci] = win.i
      return next
    })
    setTimeout(() => {
      setWinBlinks(prev => {
        const next = [...prev]
        next[ci] = null
        return next
      })
      doClaim(ci, win.n, win.i, newMarked)
    }, 2000)
  }

  const handleManualMark = useCallback((ci, idx, val) => {
    if (!gameActiveRef.current || autoModeRef.current || gameEndedRef.current) return
    if (!drawnSetRef.current.has(val)) return
    setMarkedSets(prev => {
      const next = prev.map((ms, i) => {
        if (i !== ci) return ms
        const newMs = new Set(ms)
        if (newMs.has(idx)) newMs.delete(idx)
        else newMs.add(idx)
        return newMs
      })
      markedSetsRef.current = next
      recomputeClaimReady(next)
      persistState(drawnRef.current, next)
      return next
    })
  }, [])

  const handleManualClaim = useCallback((ci) => {
    if (!gameActiveRef.current || autoModeRef.current || autoTriggered.current[ci] || gameEndedRef.current) return
    const ms = markedSetsRef.current[ci]
    const win = PATTERNS.find(p => p.i.every(i => ms.has(i)))
    if (!win) return
    autoTriggered.current[ci] = true
    setWinBlinks(prev => {
      const next = [...prev]
      next[ci] = win.i
      return next
    })
    setTimeout(() => {
      setWinBlinks(prev => { const next = [...prev]; next[ci] = null; return next })
      doClaim(ci, win.n, win.i, markedSetsRef.current)
    }, 2000)
  }, [])

  async function doClaim(ci, patName, patIdx, currentMarked) {
    if (!gameActiveRef.current || gameEndedRef.current) return
    const flat = cardLookups[ci].map(cell => (cell.isFree ? 'FREE' : String(cell.val)))
    const winRef = push(ref(db, 'activeGame/winners'))
    await set(winRef, {
      name: user.name || 'Anonymous',
      phone: user.phone || 'N/A',
      playerKey,
      cardNum: cardNums[ci] || (ci + 1),
      pattern: patName,
      cardFull: flat,
      patternIndices: patIdx,
      gameId: gameIdRef.current,
      timestamp: serverTimestamp()
    })
    const tx = await runTransaction(ref(db, 'activeGame/ended'), cur => cur === true ? undefined : true)
    if (tx.committed) iAmTheEnderRef.current = true
  }

  function handleToggleAuto() {
    const newAuto = !autoModeRef.current
    setAutoMode(newAuto)
    autoModeRef.current = newAuto
    if (isSpectator || forceSpec || !cards) return
    setMarkedSets(prev => {
      const next = prev.map((ms, ci) => {
        const newMs = new Set(ms)
        if (newAuto) {
          cardLookups[ci].forEach(cell => {
            if (!cell.isFree && drawnSetRef.current.has(cell.val)) newMs.add(cell.idx)
          })
        }
        return newMs
      })
      markedSetsRef.current = next
      recomputeClaimReady(next)
      if (newAuto && gameActiveRef.current && !gameEndedRef.current) {
        next.forEach((ms, ci) => {
          if (!autoTriggered.current[ci]) {
            const win = PATTERNS.find(p => p.i.every(i => ms.has(i)))
            if (win) triggerAutoBingo(ci, win, next)
          }
        })
      }
      return next
    })
  }

  function safeRedirect() {
    if (cleanupDoneRef.current) return
    cleanupDoneRef.current = true
    ;['selectedCartelas', 'cartelaNumbers'].forEach(k => localStorage.removeItem(k))
    try { if (reconnectKeyRef.current) localStorage.removeItem(reconnectKeyRef.current) } catch (e) {}
    navigate('/cartela')
  }

  async function cleanup() {
    if (cleanupDoneRef.current) return
    if (iAmTheEnderRef.current) {
      try {
        await update(ref(db), {
          'activeGame': null,
          'lobby': null
        })
      } catch (e) {}
    }
    safeRedirect()
  }

  function startOverlayCountdown() {
    let remaining = REDIRECT_SEC
    setCdSec(remaining)
    if (cdTimerRef.current) clearInterval(cdTimerRef.current)
    cdTimerRef.current = setInterval(() => {
      remaining--
      setCdSec(remaining)
      if (remaining <= 0) {
        clearInterval(cdTimerRef.current)
        cdTimerRef.current = null
        if (iAmTheEnderRef.current) cleanup()
        else safeRedirect()
      }
    }, 1000)
  }

  const overlayPrizeRef = useRef(0)
  useEffect(() => { overlayPrizeRef.current = currentPrize }, [currentPrize])

  async function handleWinners(winnersMap) {
    if (overlayShownRef.current) return
    overlayShownRef.current = true
    setOverlayShown(true)
    gameEndedRef.current = true
    gameActiveRef.current = false
    setGameEnded(true)
    setGameActive(false)
    if (syncTickerRef.current) { clearInterval(syncTickerRef.current); syncTickerRef.current = null }
    if (drawLoopRef.current) { clearInterval(drawLoopRef.current); drawLoopRef.current = null }

    const wList = Object.values(winnersMap || {})
    if (!wList.length) { safeRedirect(); return }

    const total = wList.length
    const myWins = wList.filter(w => w.playerKey === playerKey)
    const iWon = myWins.length > 0
    const split = Math.floor(overlayPrizeRef.current / total)
    const myShare = split * myWins.length

    playWinnerSound(false)

    if (iWon) {
      try {
        await runTransaction(ref(db, `users/${playerKey}/balance`), b => (b || 0) + myShare)
      } catch (e) {}
    }

    setWinnersList(wList)
    setOverlayPrize(overlayPrizeRef.current)
    startOverlayCountdown()
  }

  async function endGame() {
    if (gameEndedRef.current) return
    gameEndedRef.current = true
    gameActiveRef.current = false
    iAmTheEnderRef.current = true
    setGameEnded(true); setGameActive(false)
    if (syncTickerRef.current) { clearInterval(syncTickerRef.current); syncTickerRef.current = null }
    if (drawLoopRef.current) { clearInterval(drawLoopRef.current); drawLoopRef.current = null }
    await set(ref(db, 'activeGame/ended'), true)
    setTimeout(() => { if (!overlayShownRef.current) safeRedirect() }, 8000)
  }

  function reapplyToCards(currentDrawn, currentMarked, currentAuto) {
    if (!cards) return currentMarked
    const dSet = new Set(currentDrawn)
    const newMarked = currentMarked.map((ms, ci) => {
      const newMs = new Set(ms)
      if (currentAuto) {
        cardLookups[ci].forEach(cell => {
          if (!cell.isFree && dSet.has(cell.val)) newMs.add(cell.idx)
        })
      }
      return newMs
    })
    setMarkedSets(newMarked)
    markedSetsRef.current = newMarked
    recomputeClaimReady(newMarked)
    return newMarked
  }

  function setupConnectionMonitor() {
    const connRef = ref(db, '.info/connected')
    let wasOffline = false
    onValue(connRef, async snap => {
      const online = snap.val() === true
      if (!online) { wasOffline = true; persistState() }
      else if (wasOffline && online) {
        wasOffline = false
        setIsSyncing(true)
        const endedSnap = await get(ref(db, 'activeGame/ended'))
        if (endedSnap.val() === true) {
          setIsSyncing(false)
          gameEndedRef.current = true; gameActiveRef.current = false
          setGameEnded(true); setGameActive(false)
          const wSnap = await get(ref(db, 'activeGame/winners'))
          if (wSnap.exists() && !overlayShownRef.current) { handleWinners(wSnap.val()); return }
          if (!overlayShownRef.current) safeRedirect()
          return
        }
        await resyncAfterReconnect()
        setIsSyncing(false)
      }
    })
  }

  async function resyncAfterReconnect() {
    const endedSnap = await get(ref(db, 'activeGame/ended'))
    if (endedSnap.val() === true) {
      const wSnap = await get(ref(db, 'activeGame/winners'))
      if (wSnap.exists() && !overlayShownRef.current) { handleWinners(wSnap.val()); return }
      if (!overlayShownRef.current) safeRedirect()
      return
    }
    const numSnap = await get(ref(db, 'activeGame/drawnNumbers'))
    if (numSnap.exists()) {
      const nums = []
      numSnap.forEach(c => { const d = c.val(); if (d?.number) nums.push(d) })
      nums.sort((a, b) => (a.drawnAt || 0) - (b.drawnAt || 0))
      const newDrawn = nums.map(d => d.number)
      setDrawn(newDrawn)
      drawnRef.current = newDrawn
      drawnSetRef.current = new Set(newDrawn)
      updateHistFrom(newDrawn)
      const newMarked = reapplyToCards(newDrawn, markedSetsRef.current, autoModeRef.current)
      persistState(newDrawn, newMarked)
    }
  }

  // ─────────────────────────────────────────────────────────
  // MAIN INIT LOOP
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    let unmounted = false

    async function init() {
      try {
        const endedSnap = await get(ref(db, 'activeGame/ended'))
        if (endedSnap.val() === true) {
          gameEndedRef.current = true
          const wSnap = await get(ref(db, 'activeGame/winners'))
          if (wSnap.exists()) { handleWinners(wSnap.val()) } else { safeRedirect() }
          return
        }

        // Resolve the real game id BEFORE touching localStorage snapshots,
        // so reconnect-state restoration can actually validate against it
        // (this used to run before gameId was known, so the validation
        // never had anything real to check against).
        const gameNumSnap = await get(ref(db, 'activeGame/gameNum'))
        if (gameNumSnap.exists()) {
          const num = gameNumSnap.val()
          setGameNum(num)
          const realId = `GAME_${num}`
          setGameId(realId)
          setReconnectKey(realId)
        }

        restoreStateFromStorage()

        const numSnap = await get(ref(db, 'activeGame/drawnNumbers'))
        if (numSnap.exists()) {
          const nums = []
          numSnap.forEach(c => { const d = c.val(); if (d?.number) nums.push(d) })
          nums.sort((a, b) => (a.drawnAt || 0) - (b.drawnAt || 0))
          const initDrawn = nums.map(d => d.number)
          drawnRef.current = initDrawn
          drawnSetRef.current = new Set(initDrawn)
          setDrawn(initDrawn)
          updateHistFrom(initDrawn)
          if (!isSpectator && !forceSpec && cards) {
            reapplyToCards(initDrawn, markedSetsRef.current, autoModeRef.current)
          }
        }

        const startedSnap = await get(ref(db, 'activeGame/started'))
        if (startedSnap.val() === true) {
          gameStartedRef.current = true
          gameActiveRef.current = true
          setGameStarted(true)
          setGameActive(true)
        }

        const wSnap = await get(ref(db, 'activeGame/winners'))
        if (wSnap.exists()) {
          handleWinners(wSnap.val())
          return
        }

        if (unmounted) return

        const unsubChildAdded = onChildAdded(ref(db, 'activeGame/drawnNumbers'), snap => {
          if (gameEndedRef.current) return
          const d = snap.val()
          if (!d?.number) return
          if (drawnSetRef.current.has(d.number)) return
          const n = d.number
          const newDrawn = [...drawnRef.current, n]
          drawnRef.current = newDrawn
          drawnSetRef.current = new Set(newDrawn)
          setDrawn(newDrawn)
          updateHistFrom(newDrawn)
          setJustCalled(n)
          if (!isMuted) playNum(n, false)
          if (!isSpectator && !forceSpec && gameActiveRef.current && cards) {
            setMarkedSets(prev => {
              const next = prev.map((ms, ci) => {
                const newMs = new Set(ms)
                if (autoModeRef.current) {
                  const idx = cardValueMaps[ci].get(n)
                  if (idx !== undefined) newMs.add(idx)
                }
                return newMs
              })
              markedSetsRef.current = next
              const newReady = next.map((ms, ci) => {
                if (autoTriggered.current[ci]) return true
                const win = PATTERNS.find(p => p.i.every(i => ms.has(i)))
                if (win && autoModeRef.current && gameActiveRef.current && !gameEndedRef.current) {
                  triggerAutoBingo(ci, win, next)
                }
                return !!win
              })
              setClaimReady(newReady)
              return next
            })
            persistState(newDrawn, markedSetsRef.current)
          }
          if (newDrawn.length >= 75 && gameActiveRef.current && !gameEndedRef.current) endGame()
        })

        const unsubWinners = onValue(ref(db, 'activeGame/winners'), snap => {
          if (snap.exists() && !overlayShownRef.current) handleWinners(snap.val())
        })

        const unsubEnded = onValue(ref(db, 'activeGame/ended'), async snap => {
          if (snap.val() === true && !gameEndedRef.current) {
            gameEndedRef.current = true; gameActiveRef.current = false
            setGameEnded(true); setGameActive(false)
            if (syncTickerRef.current) { clearInterval(syncTickerRef.current); syncTickerRef.current = null }
            if (drawLoopRef.current) { clearInterval(drawLoopRef.current); drawLoopRef.current = null }
            const wc = await get(ref(db, 'activeGame/winners'))
            if (!wc.exists()) setTimeout(safeRedirect, 1000)
            else if (!overlayShownRef.current) handleWinners(wc.val())
          }
        })

        const unsubStarted = onValue(ref(db, 'activeGame/started'), snap => {
          if (snap.val() === true && !gameStartedRef.current) {
            gameStartedRef.current = true; gameActiveRef.current = true
            setGameStarted(true); setGameActive(true)
            setPreGameCountdown(null)
            // Brief "starting" transition instead of an abrupt jump straight
            // into a populated board, per request.
            setShowStartTransition(true)
            if (startTransitionTimerRef.current) clearTimeout(startTransitionTimerRef.current)
            startTransitionTimerRef.current = setTimeout(() => setShowStartTransition(false), 900)
          }
        })

        // Cache ballsToDraw once (it's written exactly once, at game start,
        // and never changes afterwards) instead of re-fetching the whole
        // activeGame object on every draw tick.
        const unsubBalls = onValue(ref(db, 'activeGame/ballsToDraw'), snap => {
          ballsToDrawRef.current = snap.exists() ? snap.val() : null
        })

        // ── Timer-driven game start ───────────────────────────────────
        // CartelaPage writes activeGame/targetEndTime (and sets
        // activeGame/status = 'countdown') when the lobby countdown begins.
        // Every connected client watches that timestamp locally; whichever
        // client's clock crosses it first attempts to flip the game to
        // "started". Only a single lightweight field (status) is contended
        // over via transaction; the client that actually wins that flip is
        // the only one that does the heavier one-time setup (shuffling the
        // balls and writing them). Previously this ran a transaction on the
        // *entire* activeGame object, repeatedly, from every client, every
        // 250ms, until the started flag propagated back down — needlessly
        // expensive for larger lobbies.
        let targetEndTimestamp = null
        const unsubCountdown = onValue(ref(db, 'activeGame/targetEndTime'), snap => {
          targetEndTimestamp = snap.val()
        })

        if (syncTickerRef.current) clearInterval(syncTickerRef.current)
        syncTickerRef.current = setInterval(async () => {
          if (gameStartedRef.current) {
            clearInterval(syncTickerRef.current)
            syncTickerRef.current = null
            return
          }
          if (!targetEndTimestamp) return
          const remainingSec = Math.max(0, Math.ceil((targetEndTimestamp - Date.now()) / 1000))
          setPreGameCountdown(remainingSec)
          if (remainingSec > 0 || startAttemptInFlightRef.current) return

          startAttemptInFlightRef.current = true
          try {
            let before = null
            const statusResult = await runTransaction(ref(db, 'activeGame/status'), cur => {
              before = cur
              if (cur === 'countdown') return 'started'
              return cur
            })
            if (statusResult.committed && before === 'countdown') {
              // We're the one client responsible for one-time setup.
              const balls = shuffledBalls()
              await update(ref(db, 'activeGame'), {
                started: true,
                ballsToDraw: balls,
                nextBallIndex: 0
              })
            }
          } catch (e) {
            // will retry next tick
          } finally {
            startAttemptInFlightRef.current = false
          }
        }, 250)

        // Hostless ball-draw loop.
        // FIX: the previous version called push() (a network side effect)
        // *inside* the runTransaction update function. Firebase may invoke
        // that function multiple times speculatively while resolving
        // contention between clients, so a side effect inside it could fire
        // more than once for what should be a single logical draw — this is
        // exactly the kind of bug that causes duplicate number draws. Now
        // the transaction only ever does a pure counter increment; the push
        // happens once, after the promise resolves, and only by the client
        // whose attempt is confirmed (via the captured pre-transaction
        // value) to be the one that actually advanced the counter.
        if (drawLoopRef.current) clearInterval(drawLoopRef.current)
        drawLoopRef.current = setInterval(async () => {
          if (!gameStartedRef.current || gameEndedRef.current) return
          const balls = ballsToDrawRef.current
          if (!balls) return

          let capturedBefore = null
          try {
            const result = await runTransaction(ref(db, 'activeGame/nextBallIndex'), curIdx => {
              const cur = curIdx ?? 0
              capturedBefore = cur
              if (cur >= balls.length) return cur
              return cur + 1
            })
            if (result.committed && capturedBefore !== null && capturedBefore < balls.length) {
              await push(ref(db, 'activeGame/drawnNumbers'), {
                number: balls[capturedBefore],
                drawnAt: serverTimestamp()
              })
            }
          } catch (e) {
            // will retry next tick
          }
        }, 3500)

        const unsubMeta = onValue(ref(db, 'activeGame/gameNum'), snap => {
          if (snap.exists()) {
            const num = snap.val()
            setGameNum(num)
            const realId = `GAME_${num}`
            setGameId(realId)
            if (!reconnectKeyRef.current) setReconnectKey(realId)
          }
        })

        const unsubPlayers = onValue(ref(db, 'lobby/players'), snap => {
          setPlayerCount(snap.numChildren())
        })

        const unsubTaken = onValue(ref(db, 'lobby/takenCards'), snap => {
          const count = Object.keys(snap.val() || {}).length
          const p = Math.floor(count * parseInt(stakeAmt) * 0.8)
          setCurrentPrize(p)
          overlayPrizeRef.current = p
        })

        setupConnectionMonitor()
        setIsLoading(false)

        return () => {
          unmounted = true
          unsubChildAdded()
          unsubWinners()
          unsubEnded()
          unsubStarted()
          unsubBalls()
          unsubCountdown()
          unsubMeta()
          unsubPlayers()
          unsubTaken()
          if (syncTickerRef.current) clearInterval(syncTickerRef.current)
          if (drawLoopRef.current) clearInterval(drawLoopRef.current)
          if (cdTimerRef.current) clearInterval(cdTimerRef.current)
          if (startTransitionTimerRef.current) clearTimeout(startTransitionTimerRef.current)
        }
      } catch (error) {
        setLoadError(error.message || 'Failed to load game')
        setIsLoading(false)
      }
    }

    const cleanupPromise = init()
    return () => { unmounted = true; cleanupPromise.then(fn => fn && fn()) }
  }, [])

  // Clear the "just called" pulse shortly after each draw.
  useEffect(() => {
    if (justCalled === null) return
    const t = setTimeout(() => setJustCalled(null), 800)
    return () => clearTimeout(t)
  }, [justCalled])

  const handleRetry = () => {
    setIsLoading(true)
    setLoadError(null)
    window.location.reload()
  }

  if (isLoading) return <LoadingScreen />
  if (loadError) return <ErrorScreen message={loadError} onRetry={handleRetry} />
  if (showStartTransition) return <LoadingScreen label="ጨዋታው ተጀምሯል" />

  const boardCellsRendered = []
  for (let i = 1; i <= 75; i++) {
    const isDrawn = drawnSet.has(i)
    let cls = isDrawn ? `bnum ${colClass(i)}` : 'bnum'
    if (justCalled === i) cls += ' just-called'
    boardCellsRendered.push(<div key={i} className={cls}>{i}</div>)
  }

  return (
    <>
      <GameAnimStyles />

      {isSyncing && <div className="sync-badge">🔄 Syncing…</div>}

      <div className="game-stats">
        <div className="stat gold">
          <div className="lbl">Derash</div>
          <div className="val">{currentPrize}</div>
          <div className="sub">ETB</div>
        </div>
        <div className="stat">
          <div className="lbl">Players</div>
          <div className="val">{playerCount}</div>
        </div>
        <div className="stat">
          <div className="lbl">Stake</div>
          <div className="val">{stakeAmt} ETB</div>
        </div>
        <div className="stat green">
          <div className="lbl">Called</div>
          <div className="val">{calledCount}</div>
        </div>
        <button className="mute-btn" onClick={() => setIsMuted(m => !m)}>
          {isMuted ? '🔇' : '🔊'}
        </button>
      </div>

      {!gameStarted && preGameCountdown !== null && preGameCountdown > 0 && (
        <div className="starting-banner">
          🎲 Game starts in {preGameCountdown}s
        </div>
      )}

      <div className="game-main">
        <div className="game-left">
          <div className="board-hdr">
            <div className="bh b">B</div>
            <div className="bh i">I</div>
            <div className="bh n">N</div>
            <div className="bh g">G</div>
            <div className="bh o">O</div>
          </div>
          <div className="board-grid">{boardCellsRendered}</div>
          <div className="left-foot">
            <button className="refresh-btn" onClick={() => window.location.reload()}>↺ REFRESH</button>
            <div className="gid-txt" style={{ fontSize: '11px' }}>{gameId}</div>
          </div>
        </div>

        <div className="game-right">
          <div className="hist-row">
            {[4, 3, 2, 1, 0].map(i => {
              const n = histBalls[i]
              const isLatest = i === 0
              if (!n) return (
                <div key={i} className={`hbub${isLatest ? ' latest' : ''}`}>--</div>
              )
              return (
                <div
                  key={isLatest ? `latest-${n}` : i}
                  className={`hbub ${bubClass(n)}${isLatest ? ' latest pop-anim' : ''}`}
                >
                  {letter(n)}{n}
                </div>
              )
            })}
          </div>

          <div className="auto-row">
            <div className={`mode-badge ${autoMode ? 'auto' : 'manual'}`}>
              {autoMode ? 'AUTO' : 'MANUAL'}
            </div>
            <div className={`tog ${autoMode ? 'on' : 'off'}`} onClick={handleToggleAuto}>
              <div className="tog-knob" />
            </div>
          </div>

          <div className="cartelas-scroll">
            {(isSpectator || forceSpec) ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--dim)', fontSize: '12px', fontWeight: 700 }}>
                👁️ በዚህ ዙር ጨዋታ ተጀምሯል፡፡ አዲስ ዙር እስኪጀምር እዚሁ እጠብቁ፡፡
              </div>
            ) : cards && cards.map((card, ci) => (
              <BingoCard
                key={ci}
                flatCells={cardLookups[ci]}
                cardNum={cardNums[ci] || (ci + 1)}
                ci={ci}
                drawnSet={drawnSet}
                markedSet={markedSets[ci] || new Set([12])}
                autoMode={autoMode}
                gameActive={gameActive}
                gameEnded={gameEnded}
                onManualMark={handleManualMark}
                onClaim={handleManualClaim}
                winBlink={winBlinks[ci]}
                claimReady={claimReady[ci]}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="game-footer">
        <div className="live-tag">LIVE</div>
        <div className="ticker-box">
          <div className="ticker-txt">
            🏆 ጃክፖቱ እየጠበቀ ነው — መጀመሪያ ቢንጎ በማለት ሽልማቱን ይውሰዱ!
            &nbsp;&nbsp;&nbsp;
            🎯 እያንዳንዱ ቁጥር ወሳኝ ነው — ትኩረትዎን አያጡ!
            &nbsp;&nbsp;&nbsp;
            💰 አሸናፊው ሙሉ ደራሹን ይወስዳል!
            &nbsp;&nbsp;&nbsp;
            ⚡ መልካም ዕድል ለሁሉም ተጫዋቾች!
          </div>
        </div>
      </div>

      <WinnerOverlay
        show={overlayShown}
        winners={winnersList}
        playerKey={playerKey}
        currentPrize={overlayPrize}
        drawnSet={drawnSet}
        cdSec={cdSec}
      />
    </>
  )
}