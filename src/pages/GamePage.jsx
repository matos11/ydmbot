import React, { useState, useEffect, useRef, useCallback } from 'react'
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

// ── Constants ─────────────────────────────────────────────
const MIN_PLAYERS   = 2
const DRAW_INTERVAL = 3000

// ── Winner overlay card table ─────────────────────────────
function WoTable({ flat, pi, drawn }) {
  const rows = []
  for (let r = 0; r < 5; r++) {
    const cells = []
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c
      const v   = flat[idx] || ''
      let cls = ''
      if (v === 'FREE' || idx === 12) cls = 'wc-free'
      else if (pi && pi.includes(idx)) cls = 'wc-win'
      else if (drawn.includes(parseInt(v))) cls = 'wc-called'
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
}

// ── Bingo card table ──────────────────────────────────────
function BingoCard({ card, cardNum, ci, drawn, markedSet, autoMode, gameActive, gameEnded, onManualMark, onClaim, winBlink, claimReady }) {
  const cols = ['b','i','n','g','o']
  const rows = []
  for (let r = 0; r < 5; r++) {
    const cells = []
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c
      if (idx === 12) {
        cells.push(<td key={c} className="free" data-val="FREE">F</td>)
        continue
      }
      const colArr = card[cols[c]]
      const val    = c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r]
      const numVal = parseInt(val)
      const isCalled  = drawn.includes(numVal)
      const isMarked  = markedSet.has(idx)
      let tdClass = ''
      if (winBlink && winBlink.includes(idx)) {
        tdClass = 'win-blink'
      } else if (isMarked) {
        tdClass = `marked ${autoMode ? 'auto-marked' : 'manual-marked'}`
      } else if (isCalled && !autoMode) {
        tdClass = 'callable'
      }
      const handleClick = (!autoMode && isCalled && !isMarked && gameActive && !gameEnded)
        ? () => onManualMark(ci, idx, numVal)
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
          <tr>{cols.map(c => <th key={c} className={c}>{c.toUpperCase()}</th>)}</tr>
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
}

// ── Winner Overlay ────────────────────────────────────────
function WinnerOverlay({ show, winners, playerKey, currentPrize, drawn, cdSec }) {
  const canvasRef = useRef(null)
  const fireworksStarted = useRef(false)

  useEffect(() => {
    if (show && canvasRef.current && !fireworksStarted.current) {
      fireworksStarted.current = true
      startFireworks(canvasRef.current)
    }
  }, [show])

  if (!winners || !winners.length) return null

  const total      = winners.length
  const split      = Math.floor(currentPrize / total)
  const myWins     = winners.filter(w => w.playerKey === playerKey)
  const iWon       = myWins.length > 0
  const myShare    = split * myWins.length

  // Names line
  const first      = winners[0]
  const fPhone     = first.phone || ''
  const maskedFirst = fPhone.length > 4 ? fPhone.slice(0,2) + '*' + fPhone.slice(-4) : fPhone
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
              const sec    = winners[1]
              const sPhone = sec.phone || ''
              const maskedSec = sPhone.length > 4 ? sPhone.slice(0,2) + '*' + sPhone.slice(-4) : sPhone
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
            const isMe  = w.playerKey === playerKey
            const ph    = w.phone || 'N/A'
            const masked = ph.length > 6 ? ph.slice(0,3) + '·'.repeat(Math.max(0, ph.length - 6)) + ph.slice(-3) : ph
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
                <WoTable flat={w.cardFull || []} pi={w.patternIndices || []} drawn={drawn} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════
//  GAME PAGE
// ════════════════════════════════════════════════════════
export default function GamePage() {
  const navigate      = useNavigate()
  const [searchParams] = useSearchParams()
  const forceSpec     = searchParams.get('spectator') === 'true'

  // ── Session data from localStorage ──────────────────────
  const user       = (() => { try { return JSON.parse(localStorage.getItem('bingoUser') || '{}') } catch { return {} } })()
  const rawCards   = (() => { try { return JSON.parse(localStorage.getItem('selectedCartelas') || 'null') } catch { return null } })()
  const rawNums    = (() => { try { return JSON.parse(localStorage.getItem('cartelaNumbers')   || 'null') } catch { return null } })()
  const stakeAmt   = localStorage.getItem('entryFee')      || '10'
  const prizeSaved = parseInt(localStorage.getItem('prizePool')     || '0')
  const gameId     = localStorage.getItem('currentGameId') || 'UNKNOWN'
  const gameNum    = localStorage.getItem('currentGameNum') || '--'
  const numPlayers = parseInt(localStorage.getItem('numPlayers')    || '0')

  const cards    = rawCards ? (Array.isArray(rawCards) ? rawCards : [rawCards]) : null
  const cardNums = rawNums  ? (Array.isArray(rawNums)  ? rawNums  : [rawNums])  : []

  const isSpectator = !cards || cards.length === 0
  const userKey     = (user.telegram_id || user.phone || '').toString()
  const playerKey   = sanitizeKey(userKey)
  const RECONNECT_KEY = `ydm_gamestate_${gameId}`

  // ── UI State ─────────────────────────────────────────────
  const [drawn, setDrawn]             = useState([])
  const [isMuted, setIsMuted]         = useState(true)
  const [autoMode, setAutoMode]       = useState(false)
  const [currentPrize, setCurrentPrize] = useState(prizeSaved)
  const [playerCount, setPlayerCount] = useState(numPlayers)
  const [calledCount, setCalledCount] = useState('0/75')
  const [histBalls, setHistBalls]     = useState([])   // last 5 drawn, most recent first

  // ── Card marking state ───────────────────────────────────
  // markedSets[ci] = Set of marked cell indices for card ci
  const [markedSets, setMarkedSets]   = useState(() =>
    cards ? cards.map(() => new Set([12])) : []
  )
  // winBlinks[ci] = array of indices to blink, or null
  const [winBlinks, setWinBlinks]     = useState(() => cards ? cards.map(() => null) : [])
  const [claimReady, setClaimReady]   = useState(() => cards ? cards.map(() => false) : [])

  // ── Game flow state ───────────────────────────────────────
  const [gameActive, setGameActive]   = useState(false)
  const [gameEnded, setGameEnded]     = useState(false)
  const [gameStarted, setGameStarted] = useState(false)

  // ── Winner overlay state ──────────────────────────────────
  const [overlayShown, setOverlayShown] = useState(false)
  const [winnersList, setWinnersList]   = useState([])
  const [overlayPrize, setOverlayPrize] = useState(0)
  const [cdSec, setCdSec]               = useState(REDIRECT_SEC)

  // ── Host management ───────────────────────────────────────
  const isHostRef       = useRef(false)
  const numIntervalRef  = useRef(null)
  const cleanupDoneRef  = useRef(false)
  const iAmTheEnderRef  = useRef(false)
  const overlayShownRef = useRef(false)
  const gameEndedRef    = useRef(false)
  const gameActiveRef   = useRef(false)
  const gameStartedRef  = useRef(false)
  const drawnRef        = useRef([])
  const markedSetsRef   = useRef(markedSets)
  const autoModeRef     = useRef(false)
  const autoTriggered   = useRef({})
  const cdTimerRef      = useRef(null)

  // Keep refs in sync
  useEffect(() => { drawnRef.current = drawn }, [drawn])
  useEffect(() => { markedSetsRef.current = markedSets }, [markedSets])
  useEffect(() => { autoModeRef.current = autoMode }, [autoMode])
  useEffect(() => { gameEndedRef.current = gameEnded }, [gameEnded])
  useEffect(() => { gameActiveRef.current = gameActive }, [gameActive])
  useEffect(() => { gameStartedRef.current = gameStarted }, [gameStarted])

  // ── Audio context unlock ─────────────────────────────────
  useEffect(() => {
    const unlock = () => { try { new (window.AudioContext || window.webkitAudioContext)() } catch (e) {} }
    document.addEventListener('touchstart', unlock, { once: true })
    document.addEventListener('click', unlock, { once: true })
    return () => {
      document.removeEventListener('touchstart', unlock)
      document.removeEventListener('click', unlock)
    }
  }, [])

  // ── Persist / restore state ───────────────────────────────
  function persistState(newDrawn, newMarked) {
    if (gameEndedRef.current || isSpectator || forceSpec || !cards || !gameId || gameId === 'UNKNOWN') return
    try {
      localStorage.setItem(RECONNECT_KEY, JSON.stringify({
        drawn: newDrawn || drawnRef.current,
        markedSets: (newMarked || markedSetsRef.current).map(s => [...s]),
        autoTriggered: autoTriggered.current,
        gameStarted: gameStartedRef.current,
        ts: Date.now()
      }))
    } catch (e) {}
  }

  function restoreStateFromStorage() {
    if (isSpectator || forceSpec || !cards) return false
    try {
      const raw = localStorage.getItem(RECONNECT_KEY)
      if (!raw) return false
      const saved = JSON.parse(raw)
      if (Date.now() - saved.ts > 7200000) { localStorage.removeItem(RECONNECT_KEY); return false }
      if (saved.markedSets && saved.markedSets.length === cards.length) {
        const restored = saved.markedSets.map(arr => new Set(arr))
        setMarkedSets(restored)
        markedSetsRef.current = restored
      }
      if (saved.autoTriggered) autoTriggered.current = saved.autoTriggered
      return true
    } catch (e) { return false }
  }

  // ── History bubbles ───────────────────────────────────────
  function updateHistFrom(newDrawn) {
    const last5 = [...newDrawn].reverse().slice(0, 5)
    setHistBalls(last5)
    setCalledCount(`${newDrawn.length}/75`)
  }

  // ── Check win for a card ──────────────────────────────────
  function recomputeClaimReady(newMarked) {
    if (!cards) return
    const newReady = newMarked.map(ms => !!PATTERNS.find(p => p.i.every(i => ms.has(i))))
    setClaimReady(newReady)
    return newReady
  }

  // ── Auto-trigger bingo after blink ───────────────────────
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

  // ── Manual mark a cell ───────────────────────────────────
  function handleManualMark(ci, idx, val) {
    if (!gameActiveRef.current || autoModeRef.current || gameEndedRef.current) return
    if (!drawnRef.current.includes(val)) return
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
  }

  // ── Manual claim ─────────────────────────────────────────
  function handleManualClaim(ci) {
    if (!gameActiveRef.current || autoModeRef.current || autoTriggered.current[ci] || gameEndedRef.current) return
    const ms  = markedSetsRef.current[ci]
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
  }

  // ── Submit bingo claim to Firebase ───────────────────────
  async function doClaim(ci, patName, patIdx, currentMarked) {
    if (!gameActiveRef.current || gameEndedRef.current) return
    const card = cards[ci]
    const cols = ['b','i','n','g','o']
    const flat = []
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (r === 2 && c === 2) { flat.push('FREE'); continue }
        const colArr = card[cols[c]]
        flat.push(String(c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r]))
      }
    }
    const winRef = push(ref(db, 'activeGame/winners'))
    await set(winRef, {
      name: user.name || 'Anonymous',
      phone: user.phone || 'N/A',
      playerKey,
      cardNum: cardNums[ci] || (ci + 1),
      pattern: patName,
      cardFull: flat,
      patternIndices: patIdx,
      gameId,
      timestamp: serverTimestamp()
    })
    const tx = await runTransaction(ref(db, 'activeGame/ended'), cur => cur === true ? undefined : true)
    if (tx.committed) iAmTheEnderRef.current = true
  }

  // ── Toggle auto mode ─────────────────────────────────────
  function handleToggleAuto() {
    const newAuto = !autoModeRef.current
    setAutoMode(newAuto)
    autoModeRef.current = newAuto
    if (isSpectator || forceSpec || !cards) return
    setMarkedSets(prev => {
      const next = prev.map((ms, ci) => {
        const card = cards[ci]
        const cols = ['b','i','n','g','o']
        const newMs = new Set(ms)
        if (newAuto) {
          for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
              const idx = r * 5 + c
              if (idx === 12) continue
              const colArr = card[cols[c]]
              const val = parseInt(c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r])
              if (drawnRef.current.includes(val)) newMs.add(idx)
            }
          }
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

  // ── Safe redirect ─────────────────────────────────────────
  function safeRedirect() {
    if (cleanupDoneRef.current) return
    cleanupDoneRef.current = true
    ;['selectedCartela','selectedCartelas','cartelaNumber','cartelaNumbers',
      'currentGameId','currentGameNum','prizePool','numPlayers','playerList'
    ].forEach(k => localStorage.removeItem(k))
    try { localStorage.removeItem(RECONNECT_KEY) } catch (e) {}
    navigate('/cartela?fresh=true')
  }

  async function cleanup() {
    if (cleanupDoneRef.current) return
    if (iAmTheEnderRef.current) {
      try {
        await update(ref(db), {
          'activeGame': null,
          'game/status': null,
          'game/meta': null,
          'lobby': null
        })
      } catch (e) {}
    }
    safeRedirect()
  }

  // ── Start overlay countdown ───────────────────────────────
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

  // Ref to always have latest prize in handleWinners closure
  const overlayPrizeRef = useRef(prizeSaved)
  useEffect(() => { overlayPrizeRef.current = currentPrize }, [currentPrize])

  // ── Handle winners ────────────────────────────────────────
  async function handleWinners(winnersMap) {
    if (overlayShownRef.current) return
    overlayShownRef.current = true
    setOverlayShown(true)
    gameEndedRef.current = true
    gameActiveRef.current = false
    setGameEnded(true)
    setGameActive(false)
    if (numIntervalRef.current) { clearInterval(numIntervalRef.current); numIntervalRef.current = null }

    const wList = Object.values(winnersMap || {})
    if (!wList.length) { safeRedirect(); return }

    const total    = wList.length
    const myWins   = wList.filter(w => w.playerKey === playerKey)
    const iWon     = myWins.length > 0
    const split    = Math.floor(overlayPrizeRef.current / total)
    const myShare  = split * myWins.length

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

  // ── Host: generate next number ────────────────────────────
  async function genNextNumber() {
    if (!gameActiveRef.current || gameEndedRef.current || !isHostRef.current) return
    if (drawnRef.current.length >= 75) { endGame(); return }
    const snap = await get(ref(db, 'activeGame/drawnNumbers'))
    const fbDrawn = new Set()
    if (snap.exists()) snap.forEach(c => { const d = c.val(); if (d?.number) fbDrawn.add(d.number) })
    const avail = []
    for (let i = 1; i <= 75; i++) if (!fbDrawn.has(i)) avail.push(i)
    if (!avail.length) { endGame(); return }
    const n = avail[Math.floor(Math.random() * avail.length)]
    await set(ref(db, `activeGame/drawnNumbers/${n}`), {
      number: n,
      drawnAt: serverTimestamp(),
      letter: letter(n)
    })
  }

  // FIX: centralized "start the draw loop if eligible" — called from every
  // place that could flip either of the two preconditions (isHost, gameActive)
  // so there is no ordering dependency between host-election and game-start.
  function maybeStartGen() {
    if (isHostRef.current && gameActiveRef.current && !gameEndedRef.current && !numIntervalRef.current) {
      startGen()
    }
  }

  function startGen() {
    if (numIntervalRef.current) clearInterval(numIntervalRef.current)
    // Draw immediately on start instead of waiting a full DRAW_INTERVAL,
    // so the first number appears without a dead pause.
    genNextNumber()
    numIntervalRef.current = setInterval(async () => {
      if (!gameActiveRef.current || gameEndedRef.current) {
        clearInterval(numIntervalRef.current); numIntervalRef.current = null; return
      }
      const hostSnap = await get(ref(db, 'activeGame/host'))
      if (hostSnap.val() !== playerKey) {
        clearInterval(numIntervalRef.current); isHostRef.current = false; numIntervalRef.current = null; return
      }
      await genNextNumber()
    }, DRAW_INTERVAL)
  }

  // FIX: single host-election path (the old code had two near-duplicate
  // functions, tryHost + tryHostClaim, with slightly different behavior).
  // This one always attempts the claim, and on success or on discovering
  // we already are host, calls maybeStartGen() instead of re-checking
  // gameStarted/gameActive inline (which is what caused the race).
  async function claimHost() {
    if (gameEndedRef.current) return
    const myId = playerKey || ('host_' + Date.now())
    const tx = await runTransaction(ref(db, 'activeGame/hostLock'), cur => cur === null ? myId : undefined)
    if (tx.committed && tx.snapshot.val() === myId) {
      isHostRef.current = true
      await set(ref(db, 'activeGame/host'), myId)
      onDisconnect(ref(db, 'activeGame/hostLock')).remove()
      onDisconnect(ref(db, 'activeGame/host')).remove()
      maybeStartGen()
      return
    }
    // Someone else holds the lock — check if it's actually us from a
    // previous claim (e.g. effect re-ran) so we don't orphan our own host status.
    const hostSnap = await get(ref(db, 'activeGame/host'))
    if (hostSnap.val() === myId) {
      isHostRef.current = true
      maybeStartGen()
    }
  }

  async function endGame() {
    if (gameEndedRef.current) return
    gameEndedRef.current = true
    gameActiveRef.current = false
    iAmTheEnderRef.current = true
    setGameEnded(true); setGameActive(false)
    if (numIntervalRef.current) { clearInterval(numIntervalRef.current); numIntervalRef.current = null }
    await set(ref(db, 'activeGame/ended'), true)
    setTimeout(() => { if (!overlayShownRef.current) safeRedirect() }, 8000)
  }

  // ── Reapply drawn to cards (reconnect) ───────────────────
  function reapplyToCards(currentDrawn, currentMarked, currentAuto) {
    if (!cards) return currentMarked
    const newMarked = currentMarked.map((ms, ci) => {
      const card = cards[ci]
      const cols = ['b','i','n','g','o']
      const newMs = new Set(ms)
      if (currentAuto) {
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 5; c++) {
            const idx = r * 5 + c
            if (idx === 12) continue
            const colArr = card[cols[c]]
            const val    = parseInt(c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r])
            if (currentDrawn.includes(val)) newMs.add(idx)
          }
        }
      }
      return newMs
    })
    setMarkedSets(newMarked)
    markedSetsRef.current = newMarked
    recomputeClaimReady(newMarked)
    return newMarked
  }

  // ── Connection monitor ────────────────────────────────────
  function setupConnectionMonitor() {
    const connRef = ref(db, '.info/connected')
    let wasOffline = false
    onValue(connRef, async snap => {
      const online = snap.val() === true
      if (!online) { wasOffline = true; persistState() }
      else if (wasOffline && online) {
        wasOffline = false
        const endedSnap = await get(ref(db, 'activeGame/ended'))
        if (endedSnap.val() === true) {
          gameEndedRef.current = true; gameActiveRef.current = false
          setGameEnded(true); setGameActive(false)
          const wSnap = await get(ref(db, 'activeGame/winners'))
          if (wSnap.exists() && !overlayShownRef.current) { handleWinners(wSnap.val()); return }
          if (!overlayShownRef.current) safeRedirect()
          return
        }
        resyncAfterReconnect()
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
      updateHistFrom(newDrawn)
      const newMarked = reapplyToCards(newDrawn, markedSetsRef.current, autoModeRef.current)
      persistState(newDrawn, newMarked)
    }
    if (gameActiveRef.current && !gameEndedRef.current && !isHostRef.current) await claimHost()
    else maybeStartGen()
  }

  // ─────────────────────────────────────────────────────────
  // MAIN INIT
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    let unmounted = false

    async function init() {
      // Check if game already ended
      const endedSnap = await get(ref(db, 'activeGame/ended'))
      if (endedSnap.val() === true) {
        gameEndedRef.current = true
        const wSnap = await get(ref(db, 'activeGame/winners'))
        if (wSnap.exists()) { handleWinners(wSnap.val()) } else { safeRedirect() }
        return
      }

      // Restore persisted state
      restoreStateFromStorage()

      // Load existing drawn numbers
      const numSnap = await get(ref(db, 'activeGame/drawnNumbers'))
      if (numSnap.exists()) {
        const nums = []
        numSnap.forEach(c => { const d = c.val(); if (d?.number) nums.push(d) })
        nums.sort((a, b) => (a.drawnAt || 0) - (b.drawnAt || 0))
        const initDrawn = nums.map(d => d.number)
        drawnRef.current = initDrawn
        setDrawn(initDrawn)
        updateHistFrom(initDrawn)
        if (!isSpectator && !forceSpec && cards) {
          reapplyToCards(initDrawn, markedSetsRef.current, autoModeRef.current)
        }
      }

      // FIX: treat `activeGame/started` as the single source of truth.
      // Previously this page ALSO derived "started" independently from a
      // live `lobby/players` count threshold, which could disagree with the
      // lobby's own `game/status` flow and race against host election —
      // that mismatch is what caused the draw loop to never start. The
      // lobby (CartelaPage) is solely responsible for deciding when a round
      // begins; this page only reacts to `activeGame/started`.
      const startedSnap = await get(ref(db, 'activeGame/started'))
      if (startedSnap.val() === true) {
        gameStartedRef.current = true
        gameActiveRef.current  = true
        setGameStarted(true)
        setGameActive(true)
      } else {
        // Fallback: if the lobby already flagged this round as started via
        // game/status (set by CartelaPage's triggerGameStart) but
        // activeGame/started hasn't been written yet, mirror it now so the
        // host doesn't sit idle waiting on a flag nobody will set.
        const statusSnap = await get(ref(db, 'game/status'))
        if (statusSnap.val() === 'started') {
          gameStartedRef.current = true
          gameActiveRef.current = true
          setGameStarted(true)
          setGameActive(true)
          await runTransaction(ref(db, 'activeGame/started'), cur => cur === true ? undefined : true)
        }
      }

      // Check for existing winners
      const wSnap = await get(ref(db, 'activeGame/winners'))
      if (wSnap.exists()) { handleWinners(wSnap.val()); return }

      if (unmounted) return

      // ── Attach realtime listeners ──────────────────────────

      // child_added for live number drawing
      const unsubChildAdded = onChildAdded(ref(db, 'activeGame/drawnNumbers'), snap => {
        if (gameEndedRef.current) return
        const d = snap.val()
        if (!d?.number) return
        if (drawnRef.current.includes(d.number)) return
        const n = d.number
        const newDrawn = [...drawnRef.current, n]
        drawnRef.current = newDrawn
        setDrawn(newDrawn)
        updateHistFrom(newDrawn)
        if (!isMuted) playNum(n, false)
        if (!isSpectator && !forceSpec && gameActiveRef.current && cards) {
          setMarkedSets(prev => {
            const next = prev.map((ms, ci) => {
              const card = cards[ci]
              const cols = ['b','i','n','g','o']
              const newMs = new Set(ms)
              for (let r = 0; r < 5; r++) {
                for (let c = 0; c < 5; c++) {
                  const idx = r * 5 + c
                  if (idx === 12) continue
                  const colArr = card[cols[c]]
                  const val = parseInt(c === 2 ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r])
                  if (val === n && autoModeRef.current) newMs.add(idx)
                }
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

      // Winners
      const unsubWinners = onValue(ref(db, 'activeGame/winners'), snap => {
        if (snap.exists() && !overlayShownRef.current) handleWinners(snap.val())
      })

      // Ended
      const unsubEnded = onValue(ref(db, 'activeGame/ended'), async snap => {
        if (snap.val() === true && !gameEndedRef.current) {
          gameEndedRef.current = true; gameActiveRef.current = false
          setGameEnded(true); setGameActive(false)
          if (numIntervalRef.current) { clearInterval(numIntervalRef.current); numIntervalRef.current = null }
          const wc = await get(ref(db, 'activeGame/winners'))
          if (!wc.exists()) setTimeout(safeRedirect, 1000)
          else if (!overlayShownRef.current) handleWinners(wc.val())
        }
      })

      // Started — FIX: this is now the ONLY place (besides the init fallback
      // above) that flips gameActive/gameStarted to true. As soon as it does,
      // it calls maybeStartGen(), which is safe to call regardless of
      // whether host election has already completed or not, because
      // claimHost() ALSO calls maybeStartGen() after winning the lock.
      // Whichever of the two (host election, started-flag) resolves last is
      // the one that actually kicks off the draw loop — no more race.
      const unsubStarted = onValue(ref(db, 'activeGame/started'), snap => {
        if (snap.val() === true && !gameStartedRef.current) {
          gameStartedRef.current = true; gameActiveRef.current = true
          setGameStarted(true); setGameActive(true)
        }
        if (snap.val() === true) maybeStartGen()
      })

      // Mirror game/status -> activeGame/started in case CartelaPage's
      // lobby flow sets the former before this page's listener above is
      // attached (covered by the init() fallback too, but this also
      // catches the case where the status flips WHILE this page is open,
      // e.g. spectators who joined mid-lobby).
      const unsubStatus = onValue(ref(db, 'game/status'), async snap => {
        if (snap.val() === 'started' && !gameStartedRef.current) {
          gameStartedRef.current = true; gameActiveRef.current = true
          setGameStarted(true); setGameActive(true)
          await runTransaction(ref(db, 'activeGame/started'), cur => cur === true ? undefined : true)
          maybeStartGen()
        }
      })

      // Player count (display only — no longer drives game-start decisions)
      const unsubPlayers = onValue(ref(db, 'lobby/players'), snap => {
        setPlayerCount(snap.numChildren())
      })

      // Prize sync
      const unsubTaken = onValue(ref(db, 'lobby/takenCards'), snap => {
        const count = Object.keys(snap.val() || {}).length
        const p = Math.floor(count * parseInt(stakeAmt) * 0.8)
        setCurrentPrize(p)
        overlayPrizeRef.current = p
      })

      // Host lock failover
      const unsubHostLock = onValue(ref(db, 'activeGame/hostLock'), async snap => {
        if (!snap.exists() && !isHostRef.current && gameActiveRef.current && !gameEndedRef.current) {
          await claimHost()
        }
      })

      setupConnectionMonitor()
      await claimHost()

      // Cleanup on unmount
      return () => {
        unmounted = true
        unsubChildAdded()
        unsubWinners()
        unsubEnded()
        unsubStarted()
        unsubStatus()
        unsubPlayers()
        unsubTaken()
        unsubHostLock()
        if (numIntervalRef.current) clearInterval(numIntervalRef.current)
        if (cdTimerRef.current) clearInterval(cdTimerRef.current)
      }
    }

    const cleanupPromise = init()
    return () => { unmounted = true; cleanupPromise.then(fn => fn && fn()) }
  }, [])

  // ── Board cells ───────────────────────────────────────────
  const boardCellsRendered = []
  for (let i = 1; i <= 75; i++) {
    const isDrawn = drawn.includes(i)
    const cls = isDrawn ? `bnum ${colClass(i)}` : 'bnum'
    boardCellsRendered.push(<div key={i} className={cls}>{i}</div>)
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <>
      {/* Stats bar */}
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

      <div className="game-main">
        {/* Left: 75-ball board */}
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
            <div className="gid-txt">Game <span>{gameNum}</span></div>
          </div>
        </div>

        {/* Right: history + cards */}
        <div className="game-right">
          {/* Ball history */}
          <div className="hist-row">
            {[4,3,2,1,0].map(i => {
              const n = histBalls[i]
              const isLatest = i === 0
              if (!n) return (
                <div key={i} className={`hbub${isLatest ? ' latest' : ''}`}>--</div>
              )
              return (
                <div key={i} className={`hbub ${bubClass(n)}${isLatest ? ' latest' : ''}`}>
                  {letter(n)}{n}
                </div>
              )
            })}
          </div>

          {/* Auto/manual toggle */}
          <div className="auto-row">
            <div className={`mode-badge ${autoMode ? 'auto' : 'manual'}`}>
              {autoMode ? 'AUTO' : 'MANUAL'}
            </div>
            <div className={`tog ${autoMode ? 'on' : 'off'}`} onClick={handleToggleAuto}>
              <div className="tog-knob" />
            </div>
          </div>

          {/* Cartelas */}
          <div className="cartelas-scroll">
            {(isSpectator || forceSpec) ? (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--dim)', fontSize: '12px', fontWeight: 700 }}>
                👁️ በዚህ ዙር ጨዋታ ተጀምሯል፡፡ አዲስ ዙር እስኪጀምር እዚሁ እጠብቁ፡፡
              </div>
            ) : cards && cards.map((card, ci) => (
              <BingoCard
                key={ci}
                card={card}
                cardNum={cardNums[ci] || (ci + 1)}
                ci={ci}
                drawn={drawn}
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

      {/* Footer ticker */}
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

      {/* Winner overlay */}
      <WinnerOverlay
        show={overlayShown}
        winners={winnersList}
        playerKey={playerKey}
        currentPrize={overlayPrize}
        drawn={drawn}
        cdSec={cdSec}
      />
    </>
  )
}