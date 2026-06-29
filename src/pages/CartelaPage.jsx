import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../firebase.js'; 
import { ref, onValue, get, update, runTransaction, serverTimestamp } from 'firebase/database';

const FIXED_FEE = 10;
const PAY_MARGIN = 0.8;
const MIN_PLAYERS = 2;
const MAX_SELECTION_LIMIT = 2; 

const sanitizeKey = (val) => (val || '').toString().replace(/[.#$[\]/]/g, '_');

const MatrixButton = React.memo(({ id, status, onClick }) => {
  let className = "nc";
  if (status === "selected") className = "nc selected";
  if (status === "taken") className = "nc taken";
  
  return (
    <div className={className} onClick={() => onClick(id)}>
      {id}
    </div>
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
  const [prize, setPrize] = useState(0);
  const [gameNum, setGameNum] = useState('--');
  const [timerVal, setTimerVal] = useState('--');
  const [loading, setLoading] = useState(true);

  const stateRef = useRef({});
  stateRef.current = { selectedCards, pCount, bal, taken, prize, playerKey, user };
  
  const countdownIntervalRef = useRef(null);

  // Fetch all 450 cartelas on mount
  useEffect(() => {
    get(ref(db, 'cartelas')).then(snap => {
      if (snap.exists()) {
        const data = snap.val();
        const mapped = {};
        Object.keys(data).forEach(k => { mapped[Number(k)] = data[k]; });
        setAllCards(mapped);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

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
    const { taken: tk, selectedCards: sc, bal: currentBal, playerKey: pk } = stateRef.current;
    if (tk[id] && tk[id] !== pk) return;

    const idx = sc.findIndex(c => c.id === id);
    let nextCards = [...sc];

    if (idx !== -1) {
      nextCards.splice(idx, 1);
    } else {
      if (sc.length >= MAX_SELECTION_LIMIT) return; 
      if (currentBal < FIXED_FEE) return;
      nextCards.push({ id, data: allCards[id] || { b:[], i:[], n:[], g:[], o:[] } });
    }

    setSelectedCards(nextCards);
    syncSelection(nextCards, sc).catch(console.error);
  }, [allCards, syncSelection]);

  // Real-time Core Loop & Dynamic Tick Controller
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
        const count = players.length;
        setPCount(count);
        
        const totalCards = players.reduce((acc, p) => acc + (p.cardCount || 0), 0);
        setPrize(Math.floor(totalCards * FIXED_FEE * PAY_MARGIN));

        // Atomic Transaction initialization
        if (count >= MIN_PLAYERS) {
          runTransaction(ref(db, 'activeGame'), (currentData) => {
            if (!currentData) {
              return { status: 'countdown', countdownSec: 40, started: false };
            }
            if (currentData.status !== 'countdown' && currentData.status !== 'started') {
              currentData.status = 'countdown';
              currentData.countdownSec = 40;
              currentData.started = false;
            }
            return currentData;
          });
        } else {
          update(ref(db, 'activeGame'), { status: 'waiting', countdownSec: null });
        }
      }),
      onValue(ref(db, 'activeGame/gameNum'), snap => {
        if (snap.val()) setGameNum(snap.val());
      }),
      onValue(ref(db, 'activeGame/countdownSec'), snap => {
        const val = snap.val();
        if (val !== null && val !== undefined) {
          setTimerVal(`${val}s`);
          if (val <= 0) {
            update(ref(db, 'activeGame'), { status: 'started', started: true });
          }
        } else {
          setTimerVal('--');
        }
      }),
      onValue(ref(db, 'activeGame/status'), snap => {
        if (snap.val() === 'started') {
          // Save complex selected cartelas to localStorage
          localStorage.setItem('selectedCartelas', JSON.stringify(stateRef.current.selectedCards));
          
          // Formulate light numeric state query targets
          const params = new URLSearchParams({
            players: stateRef.current.pCount.toString(),
            bet: FIXED_FEE.toString(),
            derash: stateRef.current.prize.toString()
          });
          
          // Hand-off control pipeline to GamePage with query items attached
          navigate(`/game?${params.toString()}`);
        }
      })
    ];

    // Authoritative Concurrent Decoupled Master Ticker
    countdownIntervalRef.current = setInterval(() => {
      runTransaction(ref(db, 'activeGame'), (game) => {
        if (!game || game.status !== 'countdown') return game;
        if (game.countdownSec === undefined || game.countdownSec === null) {
          game.countdownSec = 40;
          return game;
        }
        if (game.countdownSec <= 0) {
          game.status = 'started';
          game.started = true;
          game.countdownSec = 0;
        } else {
          game.countdownSec = game.countdownSec - 1;
        }
        return game;
      });
    }, 1000);

    return () => {
      unsubs.forEach(fn => fn());
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [playerKey, navigate]);

  const numbersArray = useMemo(() => Array.from({ length: 450 }, (_, i) => i + 1), []);

  return (
    <div style={{ background: '#060310', height: '100vh', display: 'flex', flexDirection: 'column', color: '#ffffff', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', overflow: 'hidden' }}>
      <style>{`
        *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        nav{background:rgba(8,4,18,0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.08);padding:7px 10px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:6px;min-height:50px;}
        .nav-group{display:flex;align-items:center;gap:5px;flex-wrap:nowrap}
        .profile-pill{display:flex;flex-direction:column;justify-content:center;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:9px;padding:4px 9px;max-width:88px;}
        .profile-pill .lbl{font-size:7.5px;font-weight:800;color:#FFB800;text-transform:uppercase;letter-spacing:.4px;line-height:1;margin-bottom:2px;}
        .profile-pill .val{font-size:11px;font-weight:800;color:#fff;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .chip{display:flex;flex-direction:column;justify-content:center;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.09);border-radius:9px;padding:4px 8px;min-width:50px;}
        .chip .lbl{font-size:7.5px;font-weight:800;color:#7c8ca0;text-transform:uppercase;letter-spacing:.4px;line-height:1;margin-bottom:2px}
        .chip .val{font-size:11px;font-weight:700;color:#fff;line-height:1}
        .chip.g{border-color:rgba(0,255,136,.28);background:rgba(0,255,136,.04);}.chip.g .val{color:#00ff88}
        .chip.au{border-color:rgba(255,184,0,.28);background:rgba(255,184,0,.04);}.chip.au .val{color:#FFB800}
        .chip.bl{border-color:rgba(0,212,255,.28);background:rgba(0,212,255,.04);}.chip.bl .val{color:#00d4ff}
        .timer-pill{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.3);border-radius:9px;padding:4px 8px;min-width:48px;height:32px;display:flex;align-items:center;justify-content:center;}
        .timer-pill span{font-size:11px;font-weight:800;color:#ff3366}
        .scroll-area{flex:1;overflow-y:auto;padding:8px 8px 4px;overscroll-behavior:contain}
        .status-row{display:flex;align-items:center;gap:7px;margin-bottom:8px;flex-wrap:wrap}
        .badge{background:rgba(157,78,221,.08);border:1px solid rgba(157,78,221,.25);border-radius:20px;padding:4px 10px;font-size:10.5px;font-weight:700;color:#d4c4f0;display:flex;align-items:center;gap:5px;}
        .num-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:3.5px;}
        .nc{background:#243f52;border:1px solid rgba(255,255,255,0.08);border-radius:6px;text-align:center;padding:7px 2px;font-size:10.5px;font-weight:700;cursor:pointer;color:#ffffff;transition:transform .12s,background .12s;user-select:none;-webkit-user-select:none;}
        .nc:active{transform:scale(.82)}
        .nc.taken{background:#ff003c;border-color:#ff3355;color:#ffffff;pointer-events:none;box-shadow:0 0 10px rgba(255,0,60,.45);}
        .nc.selected{background:#ffffff;border-color:#ffffff;color:#000000;font-weight:800;box-shadow:0 0 12px rgba(255,255,255,.35);transform:scale(1.04);}
        .panel{background:#0e0720;border-top:1.5px solid rgba(157,78,221,.4);padding:7px 8px;flex-shrink:0;box-shadow:0 -3px 20px rgba(0,0,0,.6);min-height:56px;max-height:190px;overflow:hidden;}
        .mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:5px;width:100%;}
        .mini-wrap{background:rgba(10,6,22,.7);border:1px solid rgba(157,78,221,.25);border-radius:7px;padding:4px;}
        .mini-title{font-size:8.5px;color:#00d4ff;text-align:center;margin-bottom:2px;font-weight:800;letter-spacing:.4px}
        .mini-table{border-collapse:separate;border-spacing:1.5px;margin:0 auto;width:100%;max-width:155px}
        .mini-table th{font-size:7.5px;font-weight:800;text-align:center;padding:1px 0}
        .mini-table th.b{color:#00d4ff}.mini-table th.i{color:#00ff88}.mini-table th.n{color:#FFB800}.mini-table th.g{color:#ff79c6}.mini-table th.o{color:#bd93f9}
        .mini-table td{height:17px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:3px;text-align:center;font-size:7.5px;font-weight:700;color:#fff}
        .mini-table td.free{background:rgba(255,184,0,.14);border-color:#FFB800;color:#FFB800;font-size:9px;font-weight:900}
        .panel-empty{font-size:10.5px;color:#7c8ca0;text-align:center;width:100%;display:block;padding:8px 0;line-height:1.5}
        .loading-overlay{position:fixed;inset:0;background:#0b0b0f;display:flex;align-items:center;justify-content:center;z-index:9999;}
        .spinner{width:34px;height:34px;border:3px solid rgba(255,215,0,0.25);border-top-color:#ffb800;border-radius:50%;animation:spin .7s linear infinite;}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      {loading && (
        <div className="loading-overlay">
          <div style={{ textAlign: 'center' }}>
            <div className="spinner"></div>
            <div style={{ fontSize: '12px', marginTop: '10px', letterSpacing: '3px', color: '#ffffff88' }}>LOADING...</div>
          </div>
        </div>
      )}

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
            <span>{timerVal}</span>
          </div>
        </div>
      </nav>

      <div className="scroll-area">
        <div className="status-row">
          <div className="badge">👥 {pCount} Players (Max 2 Cards)</div>
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

      <div className="panel">
        <div className="mini-grid">
          {selectedCards.length === 0 ? (
            <span className="panel-empty">Tap matrix numbers above to select cards.</span>
          ) : (
            selectedCards.map((card) => (
              <div className="mini-wrap" key={card.id}>
                <div className="mini-title">Card #{card.id}</div>
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th className="b">B</th><th className="i">I</th>
                      <th className="n">N</th><th className="g">G</th>
                      <th className="o">O</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 5 }).map((_, r) => (
                      <tr key={r}>
                        {['b', 'i', 'n', 'g', 'o'].map((col, c) => {
                          if (c === 2 && r === 2) {
                            return <td key={c} className="free">⭐</td>;
                          }
                          const colArr = card.data[col] || [];
                          const val = (c === 2) ? (r < 2 ? colArr[r] : colArr[r - 1]) : colArr[r];
                          return <td key={c}>{val || ''}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}