import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../firebase.js'; // Adjust relative path as needed
import { ref, onValue, get, set, update, remove, serverTimestamp, runTransaction } from 'firebase/database';

const FIXED_FEE = 10;
const MAX_CARDS = 450;
const PAY_MARGIN = 0.8;

// Sanitize key for Realtime Database paths
const sanitizeKey = (val) => (val || '').toString().replace(/[.#$[\]/]/g, '_');

// Isolated Matrix Button Component to avoid global context tree re-renders
const MatrixButton = React.memo(({ id, status, onClick }) => {
  return (
    <button
      className="matrix-btn"
      data-status={status}
      disabled={status === "taken"}
      onClick={() => onClick(id)}
    >
      {id}
    </button>
  );
});

export default function CartelaPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('bingoUser') || '{}'); } catch { return {}; }
  });

  const playerKey = useMemo(() => {
    const rawKey = (user.telegram_id || user.phone || '').toString();
    return sanitizeKey(rawKey);
  }, [user]);

  const [allCards, setAllCards] = useState({});
  const [taken, setTaken] = useState({});
  const [selectedCards, setSelectedCards] = useState([]);
  const [bal, setBal] = useState(0);
  const [profileName, setProfileName] = useState(user.name || 'Player');
  const [pCount, setPCount] = useState(0);
  const [gameActive, setGameActive] = useState(false);
  const [cdSec, setCdSec] = useState(null);
  const [prize, setPrize] = useState(0);
  const [gameNum, setGameNum] = useState('--');

  const stateRef = useRef({});
  stateRef.current = { selectedCards, gameActive, pCount, bal, taken, prize, playerKey, user };

  const cdTimer = useRef(null);

  // Fetch Cartela configurations
  useEffect(() => {
    if (!playerKey) return;
    get(ref(db, 'cartelas')).then(snap => {
      if (snap.exists()) {
        const data = snap.val();
        const mapped = {};
        Object.keys(data).forEach(k => { mapped[Number(k)] = data[k]; });
        setAllCards(mapped);
      }
    });
  }, [playerKey]);

  // Sync state cleanly via Atomic Write Transactions
  const syncSelection = useCallback(async (nextCards, prevCards) => {
    const pk = stateRef.current.playerKey;
    if (!pk) return;

    const diff = nextCards.length - prevCards.length;
    if (diff !== 0) {
      const tx = await runTransaction(ref(db, `users/${pk}/balance`), (curr) => {
        const val = curr ?? 0;
        const cost = diff * FIXED_FEE;
        if (cost > 0 && val < cost) return; 
        return val - cost;
      });
      if (!tx.committed) {
        setSelectedCards(prevCards);
        return;
      }
    }

    const cardNumbers = nextCards.map(c => c.id);
    const updates = {};

    // Remove obsolete records
    Object.keys(stateRef.current.taken).forEach(k => {
      if (stateRef.current.taken[k] === pk) updates[`lobby/takenCards/${k}`] = null;
    });

    if (cardNumbers.length === 0) {
      updates[`lobby/players/${pk}`] = null;
      await update(ref(db), updates);
      return;
    }

    cardNumbers.forEach(id => { updates[`lobby/takenCards/${id}`] = pk; });
    updates[`lobby/players/${pk}`] = {
      name: stateRef.current.user.name || 'Player',
      cartelas: cardNumbers,
      phone: stateRef.current.user.phone || '',
      joinedAt: serverTimestamp(),
      cardCount: cardNumbers.length,
    };

    await update(ref(db), updates);
  }, []);

  const onCardTap = useCallback((id) => {
    if (stateRef.current.gameActive) return;
    const { taken: tk, selectedCards: sc, bal: currentBal, playerKey: pk } = stateRef.current;
    if (tk[id] && tk[id] !== pk) return;

    const idx = sc.findIndex(c => c.id === id);
    let nextCards = [...sc];

    if (idx !== -1) {
      nextCards.splice(idx, 1);
    } else {
      if (sc.length >= 4) return; // Limit rules configuration
      if (currentBal < FIXED_FEE) return;
      nextCards.push({ id, data: allCards[id] || {} });
    }

    setSelectedCards(nextCards);
    syncSelection(nextCards, sc).catch(console.error);
  }, [allCards, syncSelection]);

  // Real-time synchronization listeners
  useEffect(() => {
    if (!playerKey) return;

    const unsubs = [
      onValue(ref(db, `users/${playerKey}`), snap => {
        if (snap.exists()) {
          const u = snap.val();
          setBal(u.balance ?? 0);
          setProfileName(u.first_name || u.name || 'Player');
        }
      }),
      onValue(ref(db, 'lobby/takenCards'), snap => {
        setTaken(snap.val() || {});
      }),
      onValue(ref(db, 'lobby/players'), snap => {
        const data = snap.val() || {};
        const players = Object.values(data);
        setPCount(players.length);
        const totalCards = players.reduce((acc, p) => acc + (p.cardCount || 0), 0);
        setPrize(Math.floor(totalCards * FIXED_FEE * PAY_MARGIN));
      }),
      onValue(ref(db, 'activeGame/gameNum'), snap => {
        if (snap.val()) setGameNum(snap.val());
      }),
      onValue(ref(db, 'activeGame/status'), snap => {
        const status = snap.val();
        if (status === 'countdown' || status === 'started') {
          setGameActive(true);
          if (status === 'started') {
            localStorage.setItem('selectedCartelas', JSON.stringify(stateRef.current.selectedCards));
            navigate('/game');
          }
        } else {
          setGameActive(false);
        }
      }),
      onValue(ref(db, 'activeGame/countdownSec'), snap => {
        const val = snap.val();
        setCdSec(val !== undefined && val > 0 ? val : null);
      })
    ];

    return () => {
      unsubs.forEach(fn => fn());
      if (cdTimer.current) clearInterval(cdTimer.current);
    };
  }, [playerKey, navigate]);

  const numbersArray = useMemo(() => Array.from({ length: 450 }, (_, i) => i + 1), []);

  return (
    <div style={{ background: '#060310', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#ffffff', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', overflow: 'hidden' }}>
      <style>{`
        *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        nav{background:rgba(8,4,18,0.95);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);padding:7px 10px;display:flex;align-items:center;justify-content:space-between;min-height:50px;}
        .nav-group{display:flex;align-items:center;gap:5px;}
        .profile-pill{display:flex;flex-direction:column;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:9px;padding:4px 9px;max-width:88px;}
        .profile-pill .lbl{font-size:7.5px;font-weight:800;color:#FFB800;text-transform:uppercase;line-height:1;margin-bottom:2px;}
        .profile-pill .val{font-size:11px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .chip{display:flex;flex-direction:column;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:9px;padding:4px 8px;min-width:50px;}
        .chip .lbl{font-size:7.5px;font-weight:800;color:#7c8ca0;text-transform:uppercase;line-height:1;margin-bottom:2px;}
        .chip .val{font-size:11px;font-weight:700;color:#fff;}
        .chip.g{border-color:rgba(0,255,136,.28);background:rgba(0,255,136,.04);}.chip.g .val{color:#00ff88;}
        .chip.au{border-color:rgba(255,184,0,.28);background:rgba(255,184,0,.04);}.chip.au .val{color:#FFB800;}
        .chip.bl{border-color:rgba(0,212,255,.28);background:rgba(0,212,255,.04);}.chip.bl .val{color:#00d4ff;}
        .timer-pill{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.3);border-radius:9px;padding:4px 8px;min-width:40px;height:32px;display:flex;align-items:center;justify-content:center;}
        .timer-pill span{font-size:12px;font-weight:800;color:#ff3366;}
        .scroll-area{flex:1;overflow-y:auto;padding:8px 8px 4px;}
        .status-row{display:flex;align-items:center;gap:7px;margin-bottom:8px;}
        .badge{background:rgba(157,78,221,.08);border:1px solid rgba(157,78,221,.25);border-radius:20px;padding:4px 10px;font-size:10.5px;font-weight:700;color:#d4c4f0;display:flex;align-items:center;gap:5px;}
        .num-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:3.5px;margin-bottom:12px;}
        .matrix-btn{aspect-ratio:1;border-radius:7px;border:1px solid rgba(255,255,255,0.04);background:rgba(255,255,255,0.02);color:rgba(255,255,255,0.45);font-size:13.5px;font-weight:800;cursor:pointer;transition:all 0.05s ease;}
        .matrix-btn[data-status="selected"]{background:#00d4ff !important;color:#000 !important;border-color:transparent;box-shadow:0 0 10px rgba(0,212,255,0.4);}
        .matrix-btn[data-status="taken"]{background:#ff3366 !important;color:#fff !important;border-color:transparent;cursor:not-allowed;}
      `}</style>

      <nav>
        <div className="nav-group">
          <div className="profile-pill">
            <span className="lbl">Player</span>
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
            <span className="val">{FIXED_FEE}</span>
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
            <span>{cdSec !== null ? `${cdSec}s` : '--'}</span>
          </div>
        </div>
      </nav>

      <div className="scroll-area">
        <div className="status-row">
          <div className="badge">👥 {pCount} Players</div>
        </div>
        <div className="num-grid">
          {numbersArray.map(id => {
            let status = "open";
            if (selectedCards.some(c => c.id === id)) status = "selected";
            else if (taken[id]) status = "taken";
            return <MatrixButton key={id} id={id} status={status} onClick={onCardTap} />;
          })}
        </div>
      </div>
    </div>
  );
}