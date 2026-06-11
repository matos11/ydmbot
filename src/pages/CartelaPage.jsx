import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../firebase.js'
import {
  ref, onValue, get, set, update, remove,
  serverTimestamp, runTransaction, onDisconnect
} from 'firebase/database'
import { FEE, PAY, MIN_PLAYERS, MAX_CARDS, TIMER_SEC, sanitizeKey } from '../utils.js'

// ── Server time offset ────────────────────────────────────
let svrOff = 0
onValue(ref(db, '.info/serverTimeOffset'), s => { svrOff = s.val() || 0 })
const now = () => Date.now() + svrOff

// ── Default user (replace with real auth as needed) ───────
function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}
function ensureUser() {
  let u = getUser()
  if (!u) {
    u = { name: 'Guest', phone: `guest_${Date.now()}`, telegram_id: null }
    localStorage.setItem('bingoUser', JSON.stringify(u))
  }
  return u
}

// ── Mini card preview component ───────────────────────────
function MiniCard({ data, id }) {
  if (!data) return <div className="mini-error">Loading Card Matrix...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div className="mini-wrap">
      <div className="mini-title">Card {id}</div>
      <table className="mini-table">
        <thead>
          <tr>{cols.map(l => <th key={l} className={l}>{l.toUpperCase()}</th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, r) => (
            <tr key={r}>
              {cols.map((col, c) => {
                if (c === 2 && r === 2) return <td key={c} className="free">★</td>
                const v = c === 2 ? (data.n?.[r < 2 ? r : r - 1] ?? '') : (data[cols[c]]?.[r] ?? '')
                return <td key={c}>{v}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CartelaPage() {
  const navigate = useNavigate()
  const user = ensureUser()
  const rawKey = (user.telegram_id || user.phone || '').toString()
  const playerKey = sanitizeKey(rawKey)

  // State
  const [allCards, setAllCards]           = useState({})
  const [taken, setTaken]                 = useState({})
  const [selectedCards, setSelectedCards] = useState([])
  const [bal, setBal]                     = useState(0)
  const [profileName, setProfileName]     = useState(user.name || 'Player')
  const [profileLbl, setProfileLbl]       = useState('@player')
  const [pCount, setPCount]               = useState(0)
  const [joined, setJoined]               = useState(false)
  const [gameActive, setGameActive]       = useState(false)
  const [cdSec, setCdSec]                 = useState(null)
  const [prize, setPrize]                 = useState(0)
  const [gameNum, setGameNum]             = useState('--')
  const [loading, setLoading]             = useState(true)
  const [wasDisconnected, setWasDisconnected] = useState(false)

  // Refs to avoid stale closures in intervals
  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const pendingOp = useRef(false)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  // ── Load cartelas.json from Public Folder ──────────────────
  useEffect(() => {
    fetch('cartelas.json')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP network error! Status: ${r.status}`)
        return r.json()
      })
      .then(data => {
        console.log("Successfully fetched cartelas database:", data)
        const mapped = {}
        Object.keys(data).forEach(k => { mapped[Number(k)] = data[k] })
        setAllCards(mapped)
      })
      .catch((err) => {
        console.error("Critical Error: Could not parse cartelas.json. Verify placement inside public/ folder.", err)
        setAllCards({})
      })
  }, [])

  // ── Realtime listeners ───────────────────────────────────
  useEffect(() => {
    const userRef = ref(db, `users/${playerKey}`)
    const unsub1 = onValue(userRef, snap => {
      if (snap.exists()) {
        const u = snap.val()
        setBal(u.balance !== undefined ? u.balance : 0)
        setProfileName(u.first_name || u.name || 'Player')
        if (u.username) setProfileLbl('@' + u.username)
      }
    })

    const takenRef = ref(db, 'lobby/takenCards')
    const unsub2 = onValue(takenRef, snap => {
      const t = snap.val() || {}
      setTaken(t)
      const count = Object.keys(t).length
      setPrize(Math.floor(count * FEE * PAY))
    })

    const playersRef = ref(db, 'lobby/players')
    const unsub3 = onValue(playersRef, snap => {
      const count = snap.numChildren()
      setPCount(count)
      if (count < MIN_PLAYERS) stopCountdown()
    })

    const gnRef = ref(db, 'lobby/currentGameNum')
    const unsub4 = onValue(gnRef, snap => {
      if (snap.val()) setGameNum(snap.val())
    })

    const timerRef = ref(db, 'lobby/gameStartAt')
    const unsub5 = onValue(timerRef, snap => {
      const t = snap.val()
      if (!t) { stopCountdown(); return }
      if (stateRef.current.gameActive) return
      const { pCount: pc, joined: j } = stateRef.current
      if (pc < MIN_PLAYERS || !j) { stopCountdown(); return }
      const rem = Math.ceil((t - now()) / 1000)
      if (rem > 0 && rem <= TIMER_SEC + 5) startCountdown(rem)
      else if (rem <= 0) triggerGameStart()
    })

    const endedRef = ref(db, 'activeGame/ended')
    const unsub6 = onValue(endedRef, snap => {
      if (snap.val() === true) resetLobby()
    })

    const statusRef = ref(db, 'game/status')
    const unsub7 = onValue(statusRef, snap => {
      if (snap.val() === 'started' && !stateRef.current.gameActive) {
        setGameActive(true)
        navigate(stateRef.current.joined ? '/game' : '/game?spectator=true')
      }
    })

    return () => {
      ;[unsub1, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7].forEach(u => u())
    }
  }, [playerKey, navigate])

  // ── Restore session ──────────────────────────────────────
  useEffect(() => {
    if (Object.keys(allCards).length === 0) return
    restoreSession()
  }, [allCards])

  // ── Check if game already started ───────────────────────
  useEffect(() => {
    if (!loading) return
    Promise.all([
      get(ref(db, 'game/status')),
      get(ref(db, 'game/meta/started'))
    ]).then(([statusSnap, metaSnap]) => {
      if (statusSnap.val() === 'started' || metaSnap.val() === true) {
        navigate(stateRef.current.joined ? '/game' : '/game?spectator=true')
      } else {
        setLoading(false)
      }
    })
  }, [loading, navigate])

  // ── Touch to unlock audio ────────────────────────────────
  useEffect(() => {
    const unlock = () => {
      try { new (window.AudioContext || window.webkitAudioContext)() } catch (e) {}
    }
    document.addEventListener('touchstart', unlock, { once: true })
    document.addEventListener('click', unlock, { once: true })
    return () => { document.removeEventListener('touchstart', unlock); document.removeEventListener('click', unlock) }
  }, [])

  // ── Helper Actions ───────────────────────────────────────
  async function restoreSession() {
    const snap = await get(ref(db, `lobby/players/${playerKey}`))
    if (!snap.exists()) return
    const pData = snap.val()
    const gid = pData.gameId
    gameIdRef.current = gid
    const numSnap = await get(ref(db, 'lobby/currentGameNum'))
    gameNumRef.current = numSnap.val() || 1
    setGameNum(gameNumRef.current)
    const nums = pData.cartelas || []
    const restored = nums.map(id => ({ id: parseInt(id), data: allCards[id] }))
    setSelectedCards(restored)
    setJoined(true)
    setWasDisconnected(true)
    localStorage.setItem('currentGameId', gid)
    localStorage.setItem('currentGameNum', gameNumRef.current)
    saveLocal(nums, restored.map(c => c.data), prize)
    
    const presRef = ref(db, `lobby/presence/${playerKey}`)
    set(presRef, true)
    onDisconnect(presRef).remove()
  }

  async function getOrCreateGameId() {
    if (gameIdRef.current) return gameIdRef.current
    const snap = await get(ref(db, 'lobby/currentGameId'))
    let gid = snap.val()
    if (!gid) {
      const rand = Math.random().toString(36).substring(2, 10).toUpperCase()
      gid = `BNG-${rand}`
      const txn = await runTransaction(ref(db, 'meta/gameCounter'), c => (c || 0) + 1)
      gameNumRef.current = txn.snapshot.val()
      await Promise.all([
        set(ref(db, 'lobby/currentGameId'), gid),
        set(ref(db, 'lobby/currentGameNum'), gameNumRef.current)
      ])
    } else {
      const numSnap = await get(ref(db, 'lobby/currentGameNum'))
      gameNumRef.current = numSnap.val() || 1
    }
    gameIdRef.current = gid
    setGameNum(gameNumRef.current)
    localStorage.setItem('currentGameId', gid)
    localStorage.setItem('currentGameNum', gameNumRef.current)
    return gid
  }

  function saveLocal(nums, cardsData, prizeAmt) {
    localStorage.setItem('selectedCartelas',  JSON.stringify(cardsData))
    localStorage.setItem('cartelaNumbers',    JSON.stringify(nums))
    localStorage.setItem('selectedCartela',   JSON.stringify(cardsData[0]))
    localStorage.setItem('cartelaNumber',     nums[0])
    localStorage.setItem('userName',          user.name || 'Player')
    localStorage.setItem('userId',            playerKey)
    localStorage.setItem('entryFee',          FEE)
    localStorage.setItem('currentGameId',     gameIdRef.current)
    localStorage.setItem('currentGameNum',    gameNumRef.current)
    localStorage.setItem('prizePool',         prizeAmt.toString())
    localStorage.setItem('numPlayers',        stateRef.current.pCount.toString())
  }

  async function joinWithCards(cards) {
    if (pendingOp.current) return
    if (!cards.length) return
    if (stateRef.current.bal < FEE) return
    pendingOp.current = true
    await getOrCreateGameId()
    try {
      const txn = await runTransaction(ref(db, `users/${playerKey}/balance`), b =>
        (b || 0) >= FEE ? b - FEE : undefined
      )
      if (!txn.committed) throw new Error('Insufficient balance')
      const cardNumbers = cards.map(c => c.id)
      const cardsData   = cards.map(c => c.data)
      const updates = {}
      cards.forEach(c => { updates[`lobby/takenCards/${c.id}`] = playerKey })
      updates[`lobby/players/${playerKey}`] = {
        name: user.name || 'Player',
        cartelas: cardNumbers,
        phone: user.phone || '',
        joinedAt: serverTimestamp(),
        gameId: gameIdRef.current,
        cardCount: cards.length,
        active: true
      }
      updates[`lobby/playerCards/${playerKey}`] = { cardNumbers, cardsData, gameId: gameIdRef.current }
      await update(ref(db), updates)
      saveLocal(cardNumbers, cardsData, stateRef.current.prize)
      setJoined(true)
      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()
      await checkAndStartTimer()
    } catch (e) {
      console.error(e)
      setSelectedCards([])
    } finally {
      pendingOp.current = false
    }
  }

  async function removeCard(id, currentSelected) {
    if (stateRef.current.gameActive || pendingOp.current) return
    pendingOp.current = true
    try {
      await runTransaction(ref(db, `users/${playerKey}/balance`), b => (b || 0) + FEE)
      const updates = {}
      updates[`lobby/takenCards/${id}`] = null
      const newSelected = currentSelected.filter(c => c.id !== id)
      if (!newSelected.length) {
        updates[`lobby/players/${playerKey}`]    = null
        updates[`lobby/playerCards/${playerKey}`] = null
        updates[`lobby/presence/${playerKey}`]   = null
        setJoined(false)
        stopCountdown()
        await remove(ref(db, 'lobby/gameStartAt'))
      } else {
        const cardNumbers = newSelected.map(c => c.id)
        const cardsData   = newSelected.map(c => c.data)
        updates[`lobby/players/${playerKey}/cartelas`]  = cardNumbers
        updates[`lobby/players/${playerKey}/cardCount`] = newSelected.length
        updates[`lobby/playerCards/${playerKey}`] = { cardNumbers, cardsData, gameId: gameIdRef.current }
      }
      await update(ref(db), updates)
      setSelectedCards(newSelected)
    } catch (e) {
      console.error(e)
    } finally {
      pendingOp.current = false
    }
  }

  async function onCardTap(id) {
    const { gameActive: ga, taken: tk, selectedCards: sc } = stateRef.current
    if (ga || pendingOp.current) return
    if (tk[id] && tk[id] !== playerKey) return
    const alreadyIdx = sc.findIndex(c => c.id === id)
    if (alreadyIdx !== -1) {
      if (stateRef.current.joined) await removeCard(id, sc)
      else setSelectedCards(prev => prev.filter(c => c.id !== id))
      return
    }
    if (sc.length >= MAX_CARDS) return
    if (!allCards[id]) return
    const newCard = { id, data: allCards[id] }
    const newSelected = [...sc, newCard]
    setSelectedCards(newSelected)
    await joinWithCards(newSelected)
  }

  async function checkAndStartTimer() {
    if (stateRef.current.gameActive) return
    const snap = await get(ref(db, 'lobby/players'))
    if (snap.numChildren() < MIN_PLAYERS) return
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) {
      const rem = Math.ceil((startAtSnap.val() - now()) / 1000)
      if (rem > 0 && rem <= TIMER_SEC + 5) { startCountdown(rem); return }
    }
    const startAt = now() + TIMER_SEC * 1000
    await update(ref(db), {
      'lobby/gameStartAt': startAt,
      'game/meta': {
        gameId: gameIdRef.current,
        gameNum: gameNumRef.current,
        startTime: startAt,
        status: 'waiting',
        prizePool: stateRef.current.prize
      }
    })
    startCountdown(TIMER_SEC)
  }

  function startCountdown(sec) {
    if (cdTimer.current) clearInterval(cdTimer.current)
    setCdSec(Math.max(sec, 0))
    let t = Math.max(sec, 0)
    cdTimer.current = setInterval(() => {
      t--
      setCdSec(t)
      if (t <= 0) { clearInterval(cdTimer.current); cdTimer.current = null; triggerGameStart() }
    }, 1000)
  }

  function stopCountdown() {
    if (cdTimer.current) { clearInterval(cdTimer.current); cdTimer.current = null }
    setCdSec(null)
  }

  async function triggerGameStart() {
    if (stateRef.current.gameActive) return
    const snap = await get(ref(db, 'lobby/players'))
    if (snap.numChildren() < MIN_PLAYERS || !stateRef.current.joined) {
      stopCountdown()
      await remove(ref(db, 'lobby/gameStartAt')).catch(() => {})
      return
    }
    setGameActive(true)
    localStorage.setItem('prizePool',  stateRef.current.prize.toString())
    localStorage.setItem('numPlayers', stateRef.current.pCount.toString())
    if (stateRef.current.joined) {
      await update(ref(db), { 'game/status': 'started', 'game/meta/started': true })
      navigate('/game')
    } else {
      navigate('/game?spectator=true')
    }
  }

  function resetLobby() {
    setSelectedCards([])
    setJoined(false)
    setGameActive(false)
    setWasDisconnected(false)
    stopCountdown()
  }

  // ── Render Preparation ───────────────────────────────────
  const cardIds = Object.keys(allCards).map(Number).sort((a, b) => a - b)

  function cardClass(id) {
    const { selectedCards: sc, taken: tk } = stateRef.current
    const isMine      = sc.some(c => c.id === id)
    const isMineOther = tk[id] && tk[id] === playerKey && !isMine
    if (isMine) return 'nc selected'
    if (isMineOther) return 'nc self-taken'
    if (tk[id]) return 'nc taken'
    if (gameActive) return 'nc locked'
    return 'nc'
  }

  const timerUrgent = cdSec !== null && cdSec <= 10

  return (
    <>
      {loading && (
        <div className="loading-overlay">
          <div className="loader-box">
            <div className="spinner" />
            <div className="loading-text">LOADING CARD DATABASE...</div>
          </div>
        </div>
      )}

      <nav className="lobby-nav">
        <div className="nav-group">
          <div className="profile-pill">
            <span className="lbl">{profileLbl}</span>
            <span className="val">{profileName}</span>
          </div>
          <div className="chip g">
            <span className="lbl">Balance</span>
            <span className="val">{Number(bal).toFixed(2)}</span>
          </div>
        </div>
        <div className="nav-group">
          <div className="chip">
            <span className="lbl">Stake</span>
            <span className="val">{FEE}</span>
          </div>
          <div className="chip au">
            <span className="lbl">Derash</span>
            <span className="val">{prize}</span>
          </div>
          <div className="chip bl">
            <span className="lbl">Game</span>
            <span className="val">{gameNum}</span>
          </div>
          <div className="timer-pill">
            <span className={timerUrgent ? 'urgent' : ''}>
              {cdSec !== null ? `${cdSec}s` : '--'}
            </span>
          </div>
        </div>
      </nav>

      <div className="lobby-scroll">
        <div className="status-row">
          <div className={`badge${joined ? ' active' : ''}`}>
            👥 {pCount} Player{pCount !== 1 ? 's' : ''}
          </div>
          {wasDisconnected && joined && (
            <div className="badge disconnected">📵 Reconnected — spot saved</div>
          )}
        </div>

        {/* ── Updated Main Grid Content ── */}
        <div className="num-grid">
          {cardIds.map(id => (
            <div
              key={id}
              className={cardClass(id)}
              onClick={() => onCardTap(id)}
              style={{ position: 'relative' }}
            >
              {/* Renders the raw full interactive grid matrix inside the item box */}
              <MiniCard id={id} data={allCards[id]} />
            </div>
          ))}
        </div>
      </div>

      {/* Footer Tracker panel showing what cards are currently purchased */}
      <div className="lobby-panel">
        <div className="mini-grid">
          {selectedCards.length === 0
            ? <span className="panel-empty">Tap any card template matrix above to select/buy</span>
            : (
              <div className="selected-summary-tray">
                <h3>Your Active Cards ({selectedCards.length})</h3>
                <div className="tray-row">
                  {selectedCards.map(c => (
                    <span key={c.id} className="tray-badge" onClick={() => onCardTap(c.id)}>
                      Card #{c.id} <span className="remove-x">×</span>
                    </span>
                  ))}
                </div>
              </div>
            )
          }
        </div>
      </div>
    </>
  )
}