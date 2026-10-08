import { useState, useEffect } from "react";
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip, ReferenceLine
} from "recharts";

/* ═══════════════════════════════════════════════════════════
   ЯДРО ГЕЙМИФИКАЦИИ (зеркало lib/gamification.ts)
   ═══════════════════════════════════════════════════════════ */

const LEVEL_BASE = 100, LEVEL_EXP = 0.65;
const xpForLevel = (l) => (l <= 0 ? 0 : Math.round(LEVEL_BASE * Math.pow(l, 1 / LEVEL_EXP)));

const levelFromXP = (xp) => {
  const safe = Math.max(0, xp);
  const level = Math.floor(Math.pow(safe / LEVEL_BASE, LEVEL_EXP));
  const floorXP = xpForLevel(level), ceilXP = xpForLevel(level + 1);
  return {
    level,
    xpIntoLevel: safe - floorXP,
    xpNeededForNext: ceilXP - floorXP,
    progress: (safe - floorXP) / (ceilXP - floorXP),
  };
};

const sphereCapacity = (l) => 60 + 20 * Math.max(0, l);
const sphereState = (totalXP) => {
  let level = 0, rest = Math.max(0, totalXP);
  while (rest >= sphereCapacity(level) && level < 999) { rest -= sphereCapacity(level); level++; }
  const cap = sphereCapacity(level);
  return { level, xpIntoLevel: rest, capacity: cap, progress: rest / cap };
};

// Аддитивные бонусы с потолком ×2.5 — раньше перемножались и давали ×2.64
const BONUS = { S7: 0.15, S14: 0.30, S30: 0.50, S100: 0.75, FOCUS: 0.20, MORNING: 0.10, PERFECT: 0.25 };
const MAX_BONUS = 1.5;

function calcBonus({ streakDays, isFocusSphere, morning, perfectDay }) {
  const parts = [];
  if (streakDays >= 100) parts.push({ label: "Серия 100+", value: BONUS.S100 });
  else if (streakDays >= 30) parts.push({ label: "Серия 30+", value: BONUS.S30 });
  else if (streakDays >= 14) parts.push({ label: "Серия 14+", value: BONUS.S14 });
  else if (streakDays >= 7) parts.push({ label: "Серия 7+", value: BONUS.S7 });
  if (isFocusSphere) parts.push({ label: "Фокус недели", value: BONUS.FOCUS });
  if (morning) parts.push({ label: "Раннее утро", value: BONUS.MORNING });
  if (perfectDay) parts.push({ label: "Идеальный день", value: BONUS.PERFECT });
  const raw = parts.reduce((a, p) => a + p.value, 0);
  return { multiplier: 1 + Math.min(raw, MAX_BONUS), parts, bonusCapped: raw > MAX_BONUS };
}

// Прогрессивный потолок. Считается от СЫРОГО XP, иначе обходится повторами
const TIERS = [{ t: 300, r: 1.0 }, { t: 500, r: 0.5 }, { t: Infinity, r: 0.25 }];
function applySoftCap(rawToday, rawXP) {
  let rem = rawXP, pos = Math.max(0, rawToday), granted = 0;
  for (const tier of TIERS) {
    if (rem <= 0) break;
    if (pos >= tier.t) continue;
    const take = Math.min(rem, tier.t - pos);
    granted += take * tier.r; pos += take; rem -= take;
  }
  const g = Math.round(granted);
  return { granted: g, lost: rawXP - g, rate: rawXP > 0 ? g / rawXP : 1 };
}

function awardXP(baseXP, ctx, rawToday) {
  const bonus = calcBonus(ctx);
  const beforeCap = Math.round(baseXP * bonus.multiplier);
  const cap = applySoftCap(rawToday, beforeCap);
  return { baseXP, ...bonus, beforeCap, finalXP: cap.granted, lost: cap.lost, capped: cap.rate < 1 };
}

// Минимальный радиус 15% — иначе нулевые сферы схлопывают радар в точку
const radarValue = (sphereXP, scale = 10) => {
  const { level, progress } = sphereState(sphereXP);
  return Math.max(0.15, Math.min(1, (level + progress) / scale)) * scale;
};

/* ═══════════════════════════════════════════════════════════
   ПАЛИТРА И ДАННЫЕ
   ═══════════════════════════════════════════════════════════ */

const C = {
  bg: "#0a0e14", surface: "#121820", border: "#1e2733",
  text: "#e6edf3", dim: "#7d8590", faint: "#4a5560",
  amber: "#e3b341", green: "#3fb950", red: "#f85149", blue: "#58a6ff", violet: "#a371f7",
};

const SPHERES = [
  { id: "int", name: "Интеллект", short: "ИНТ", xp: 25, icon: "◈", color: C.violet },
  { id: "biz", name: "Дело", short: "ДЕЛО", xp: 745, icon: "◆", color: C.blue },
  { id: "enr", name: "Энергия", short: "ЭНР", xp: 170, icon: "▲", color: C.green },
  { id: "ord", name: "Порядок", short: "ПОР", xp: 2, icon: "■", color: C.red },
  { id: "soc", name: "Связи", short: "СВЯЗ", xp: 0, icon: "●", color: C.amber },
];

const FOCUS_SPHERE = "enr";

const QUESTS_INIT = [
  { id: 1, title: "Взвеситься", baseXP: 5, sphere: "enr", done: true, icon: "⚖" },
  { id: 2, title: "Записать питание", baseXP: 10, sphere: "enr", done: true, icon: "◗" },
  { id: 3, title: "10 000 шагов", baseXP: 20, sphere: "enr", done: false, icon: "▶" },
  { id: 4, title: "Тренировка", baseXP: 25, sphere: "enr", done: false, icon: "▲" },
  { id: 5, title: "30 мин чтения", baseXP: 15, sphere: "int", done: false, icon: "◈" },
  { id: 6, title: "Уборка 15 мин", baseXP: 15, sphere: "ord", done: false, icon: "■" },
  { id: 7, title: "Кодинг 1 час", baseXP: 25, sphere: "biz", done: false, icon: "◆" },
];

// Окно 30 дней вместо «1/365» — приговора, который демотивирует
const mkWindow = (d) =>
  Array.from({ length: 30 }, (_, i) => (Math.sin(i * d * 1.7) + Math.cos(i * 0.9) > 0.4 ? 1 : 0));

const ACTIVITIES = [
  { id: "code", name: "Кодинг", xp: 640, icon: "◆", color: C.violet, sphere: "biz", win: mkWindow(0.9), last: 14 },
  { id: "sleep", name: "Сон", xp: 380, icon: "◐", color: C.blue, sphere: "enr", win: mkWindow(0.3), last: 30 },
  { id: "video", name: "Видеомонтаж", xp: 210, icon: "▣", color: C.red, sphere: "biz", win: mkWindow(1.4), last: 4 },
  { id: "clean", name: "Уборка", xp: 40, icon: "■", color: C.green, sphere: "ord", win: mkWindow(0.6), last: 0 },
  { id: "walk", name: "Прогулка", xp: 95, icon: "▶", color: C.amber, sphere: "enr", win: mkWindow(1.1), last: 14 },
  { id: "track", name: "Трэкинг", xp: 30, icon: "◈", color: "#79c0ff", sphere: "int", win: mkWindow(0.8), last: 4 },
];

const WEEK_XP = [
  { day: "ПН", xp: 661 }, { day: "ВТ", xp: 275 }, { day: "СР", xp: 360 },
  { day: "ЧТ", xp: 360 }, { day: "ПТ", xp: 211 }, { day: "СБ", xp: 435 }, { day: "ВС", xp: 0 },
];

const HEALTH = { start: 99, current: 95, goal: 75, kcal: 386, kcalTarget: 2000, steps: 4200, stepsTarget: 10000, sleep: 5.7 };

const REWARDS = [
  { id: 1, name: "Вкусный снек", cost: 5, icon: "◗", fav: true },
  { id: 2, name: "Час игр", cost: 10, icon: "▣", fav: false },
  { id: 3, name: "Поход в кино", cost: 30, icon: "▤", fav: false },
  { id: 4, name: "Новый гаджет", cost: 200, icon: "◈", fav: false },
];

const TABS = [
  { id: "today", label: "Сегодня", icon: "◉" },
  { id: "quests", label: "Квесты", icon: "◈" },
  { id: "progress", label: "Прогресс", icon: "▲" },
  { id: "shop", label: "Магазин", icon: "◆" },
];

/* ═══════════════════════════════════════════════════════════
   ПРИМИТИВЫ
   ═══════════════════════════════════════════════════════════ */

function Bar_({ value, max, color, height = 5 }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ background: "#0a0e14", borderRadius: 2, height, overflow: "hidden", border: `1px solid ${C.border}` }}>
      <div style={{ background: color, width: `${pct}%`, height: "100%", transition: "width .5s cubic-bezier(.4,0,.2,1)" }} />
    </div>
  );
}

function Panel({ children, accent, style, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4,
      borderLeft: accent ? `2px solid ${accent}` : `1px solid ${C.border}`,
      padding: 16, ...style,
    }}>{children}</div>
  );
}

const Label = ({ children, color = C.dim }) => (
  <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color, fontWeight: 600 }}>{children}</div>
);

const Mono = ({ children, size = 13, color = C.text, weight = 700 }) => (
  <span style={{ fontFamily: "'Space Mono', monospace", fontSize: size, color, fontWeight: weight }}>{children}</span>
);

/* Окно 30 дней — улучшение №5 */
function Window30({ days, color }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {days.map((d, i) => (
        <div key={i} style={{
          flex: 1, height: 14, borderRadius: 1,
          background: d ? color : "#0a0e14",
          border: `1px solid ${d ? color : C.border}`,
          opacity: d ? 0.35 + (i / days.length) * 0.65 : 1,
        }} />
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ПРИЛОЖЕНИЕ
   ═══════════════════════════════════════════════════════════ */

export default function LifeQuestApp() {
  const [tab, setTab] = useState("today");
  const [quests, setQuests] = useState(QUESTS_INIT);
  const [totalXP, setTotalXP] = useState(4040);
  const [rawToday, setRawToday] = useState(48);
  const [coins, setCoins] = useState(16);
  const [streak] = useState(12);
  const [freezes] = useState(2);
  const [spheresXP, setSpheresXP] = useState(() => Object.fromEntries(SPHERES.map(s => [s.id, s.xp])));
  const [toast, setToast] = useState(null);
  const [timer, setTimer] = useState(null);

  const lvl = levelFromXP(totalXP);
  const doneCount = quests.filter(q => q.done).length;

  const toggleQuest = (id) => {
    const q = quests.find(x => x.id === id);
    if (!q) return;
    if (q.done) {
      setQuests(p => p.map(x => (x.id === id ? { ...x, done: false } : x)));
      return;
    }
    const award = awardXP(q.baseXP, {
      streakDays: streak,
      isFocusSphere: q.sphere === FOCUS_SPHERE,
      morning: new Date().getHours() < 10,
      perfectDay: doneCount + 1 >= quests.length,
    }, rawToday);

    setQuests(p => p.map(x => (x.id === id ? { ...x, done: true } : x)));
    setTotalXP(v => v + award.finalXP);
    setRawToday(v => v + award.beforeCap);
    setSpheresXP(p => ({ ...p, [q.sphere]: p[q.sphere] + award.finalXP }));
    setToast({ key: Date.now(), award });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Таймер активности — добавление №2
  useEffect(() => {
    if (!timer) return;
    const i = setInterval(() => setTimer(t => (t ? { ...t, sec: t.sec + 1 } : t)), 1000);
    return () => clearInterval(i);
  }, [timer?.id]);

  const stopTimer = () => {
    if (!timer) return;
    const mins = Math.max(1, Math.round(timer.sec / 60));
    const act = ACTIVITIES.find(a => a.id === timer.id);
    const award = awardXP(Math.max(1, Math.round((mins / 60) * 20)), {
      streakDays: streak,
      isFocusSphere: act?.sphere === FOCUS_SPHERE,
      morning: new Date().getHours() < 10,
      perfectDay: false,
    }, rawToday);
    setTotalXP(v => v + award.finalXP);
    setRawToday(v => v + award.beforeCap);
    if (act) setSpheresXP(p => ({ ...p, [act.sphere]: p[act.sphere] + award.finalXP }));
    setToast({ key: Date.now(), award, note: `${act?.name} · ${mins} мин` });
    setTimer(null);
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Manrope', sans-serif", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; }
        @keyframes slideUp { from { opacity:0; transform: translateY(8px);} to {opacity:1; transform:none;} }
        @keyframes toastIn { 0%{opacity:0;transform:translateY(10px);} 10%{opacity:1;transform:none;} 90%{opacity:1;transform:none;} 100%{opacity:0;transform:translateY(-6px);} }
        @keyframes tick { 0%,100%{opacity:1;} 50%{opacity:.3;} }
        button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }
        .row { cursor: pointer; }
        .row:active { background: #161d26; }
        .tapcard { transition: transform .1s, border-color .15s; cursor: pointer; }
        .tapcard:active { transform: scale(.985); }
      `}</style>

      {/* ── Шапка ── */}
      <header style={{
        padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: C.bg,
        position: "sticky", top: 0, zIndex: 50, display: "flex", alignItems: "center", gap: 14,
      }}>
        <div style={{
          width: 42, height: 42, border: `1px solid ${C.amber}`, borderRadius: 3,
          display: "grid", placeItems: "center", flexShrink: 0, background: "#1a1408",
        }}>
          <Mono size={17} color={C.amber}>{lvl.level}</Mono>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Амир</span>
            <Mono size={10} color={C.dim} weight={400}>{lvl.xpIntoLevel} / {lvl.xpNeededForNext}</Mono>
          </div>
          <Bar_ value={lvl.xpIntoLevel} max={lvl.xpNeededForNext} color={C.amber} height={4} />
        </div>
        <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <Mono size={13} color={C.red}>{streak}</Mono>
            <div style={{ fontSize: 8, color: C.faint, letterSpacing: ".1em" }}>СЕРИЯ</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <Mono size={13} color={C.amber}>{coins}</Mono>
            <div style={{ fontSize: 8, color: C.faint, letterSpacing: ".1em" }}>МОНЕТ</div>
          </div>
        </div>
      </header>

      {/* ── Активный таймер ── */}
      {timer && (
        <div style={{ padding: "10px 16px", background: "#0f1a0e", borderBottom: `1px solid ${C.green}44`, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: C.green, animation: "tick 1.4s infinite", fontSize: 11 }}>●</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{timer.name}</div>
            <Mono size={16} color={C.green}>
              {String(Math.floor(timer.sec / 60)).padStart(2, "0")}:{String(timer.sec % 60).padStart(2, "0")}
            </Mono>
          </div>
          <button onClick={stopTimer} style={{
            border: `1px solid ${C.green}`, color: C.green, borderRadius: 3,
            padding: "7px 16px", fontSize: 11, fontWeight: 700, letterSpacing: ".08em",
          }}>ЗАВЕРШИТЬ</button>
        </div>
      )}

      {/* ── Тост с разбивкой множителя (улучшения 2 и 3) ── */}
      {toast && (
        <div key={toast.key} style={{
          position: "fixed", left: 16, right: 16, top: 74, zIndex: 200,
          background: C.surface, border: `1px solid ${C.amber}66`, borderRadius: 4,
          padding: 14, animation: "toastIn 2.8s ease forwards",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Mono size={22} color={C.amber}>+{toast.award.finalXP} XP</Mono>
            <Mono size={12} color={C.dim} weight={400}>
              {toast.award.baseXP} × {toast.award.multiplier.toFixed(2)}
            </Mono>
          </div>
          {toast.note && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{toast.note}</div>}
          {toast.award.parts.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
              {toast.award.parts.map((p, i) => (
                <span key={i} style={{ fontSize: 10, padding: "3px 7px", borderRadius: 2, border: `1px solid ${C.green}44`, color: C.green }}>
                  {p.label} +{Math.round(p.value * 100)}%
                </span>
              ))}
            </div>
          )}
          {toast.award.capped && (
            <div style={{ fontSize: 10, color: C.red, marginTop: 8 }}>
              ▼ Дневной потолок срезал {toast.award.lost} XP
            </div>
          )}
        </div>
      )}

      <main style={{ flex: 1, overflowY: "auto", padding: "14px 16px 78px" }}>
        {tab === "today" && <Today quests={quests} toggle={toggleQuest} done={doneCount} rawToday={rawToday} streak={streak} freezes={freezes} />}
        {tab === "quests" && <Quests quests={quests} toggle={toggleQuest} streak={streak} />}
        {tab === "progress" && <Progress spheresXP={spheresXP} onTimer={setTimer} timer={timer} />}
        {tab === "shop" && <Shop coins={coins} setCoins={setCoins} />}
      </main>

      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.bg, borderTop: `1px solid ${C.border}`, display: "flex", zIndex: 50 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: "11px 0 13px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            color: tab === t.id ? C.amber : C.faint,
            borderTop: `2px solid ${tab === t.id ? C.amber : "transparent"}`, marginTop: -1,
          }}>
            <span style={{ fontSize: 14 }}>{t.icon}</span>
            <span style={{ fontSize: 9, letterSpacing: ".08em", fontWeight: 700, textTransform: "uppercase" }}>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ─── ЭКРАН: СЕГОДНЯ ─── */

function Today({ quests, toggle, done, rawToday, streak, freezes }) {
  const [quickDone, setQuickDone] = useState(false);
  const cap = rawToday < 300
    ? { label: "полная ставка", color: C.green }
    : rawToday < 500
      ? { label: "×0.5 — половина", color: C.amber }
      : { label: "×0.25 — четверть", color: C.red };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Быстрый ввод «как вчера» — улучшение №6 */}
      <Panel accent={C.blue} style={{ padding: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Label color={C.blue}>Быстрый ввод</Label>
            <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>
              {quickDone ? "Вес, сон и шаги заполнены как вчера" : "Заполнить вес, сон и шаги как вчера"}
            </div>
          </div>
          <button onClick={() => setQuickDone(true)} disabled={quickDone} style={{
            border: `1px solid ${quickDone ? C.border : C.blue}`, color: quickDone ? C.faint : C.blue,
            borderRadius: 3, padding: "8px 14px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em",
          }}>{quickDone ? "ГОТОВО" : "КАК ВЧЕРА"}</button>
        </div>
      </Panel>

      {/* Квесты */}
      <Panel>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <Label>Дневные квесты</Label>
          <Mono size={11} color={done === quests.length ? C.green : C.dim}>{done}/{quests.length}</Mono>
        </div>
        <Bar_ value={done} max={quests.length} color={done === quests.length ? C.green : C.amber} height={3} />
        <div style={{ marginTop: 10 }}>
          {quests.map((q, i) => {
            const sphere = SPHERES.find(s => s.id === q.sphere);
            return (
              <div key={q.id} className="row" onClick={() => toggle(q.id)} style={{
                display: "flex", alignItems: "center", gap: 11, padding: "10px 4px",
                borderBottom: i < quests.length - 1 ? `1px solid ${C.border}` : "none",
                animation: `slideUp .25s ease ${i * 0.03}s both`,
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 2, flexShrink: 0,
                  border: `1px solid ${q.done ? C.green : C.faint}`,
                  background: q.done ? C.green : "transparent", display: "grid", placeItems: "center",
                }}>
                  {q.done && <span style={{ color: C.bg, fontSize: 11, fontWeight: 900 }}>✓</span>}
                </div>
                <span style={{ color: sphere?.color, fontSize: 12, width: 14 }}>{q.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 500,
                    textDecoration: q.done ? "line-through" : "none",
                    color: q.done ? C.faint : C.text,
                  }}>{q.title}</div>
                  {q.sphere === FOCUS_SPHERE && !q.done && (
                    <span style={{ fontSize: 9, color: C.green, letterSpacing: ".06em" }}>ФОКУС +20%</span>
                  )}
                </div>
                <Mono size={11} color={q.done ? C.faint : sphere?.color}>+{q.baseXP}</Mono>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Индикатор потолка — улучшение №3 */}
      <Panel accent={cap.color} style={{ padding: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <Label color={cap.color}>Дневной лимит</Label>
          <Mono size={11} color={cap.color}>{rawToday} XP · {cap.label}</Mono>
        </div>
        <div style={{ display: "flex", gap: 3 }}>
          <div style={{ flex: 3 }}><Bar_ value={Math.min(rawToday, 300)} max={300} color={C.green} height={4} /></div>
          <div style={{ flex: 2 }}><Bar_ value={Math.max(0, Math.min(rawToday - 300, 200))} max={200} color={C.amber} height={4} /></div>
          <div style={{ flex: 2 }}><Bar_ value={Math.max(0, rawToday - 500)} max={300} color={C.red} height={4} /></div>
        </div>
        <div style={{ fontSize: 10, color: C.faint, marginTop: 8, lineHeight: 1.45 }}>
          После 300 XP начисление снижается — защита от накрутки одним действием
        </div>
      </Panel>

      {/* Серия с заморозками — улучшение №4 */}
      <Panel accent={C.red} style={{ padding: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div>
            <Mono size={26} color={C.red}>{streak}</Mono>
            <div style={{ fontSize: 9, color: C.faint, letterSpacing: ".1em" }}>ДНЕЙ ПОДРЯД</div>
          </div>
          <div style={{ flex: 1, borderLeft: `1px solid ${C.border}`, paddingLeft: 14 }}>
            <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
              {[0, 1].map(i => (
                <span key={i} style={{
                  fontSize: 10, padding: "2px 7px", borderRadius: 2,
                  border: `1px solid ${i < freezes ? C.blue : C.border}`,
                  color: i < freezes ? C.blue : C.faint,
                }}>❄ {i < freezes ? "готова" : "истрачена"}</span>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.45 }}>
              Пропуск тратит заморозку. Если их нет — серия падает на 3 дня, а не в ноль.
            </div>
          </div>
        </div>
      </Panel>

      {/* Здоровье */}
      <Panel>
        <Label>Пульс дня</Label>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 11 }}>
          {[
            { l: "Вес", v: `${HEALTH.current} кг`, s: `цель ${HEALTH.goal}`, c: C.green, pct: ((HEALTH.start - HEALTH.current) / (HEALTH.start - HEALTH.goal)) * 100 },
            { l: "Питание", v: `${HEALTH.kcal}`, s: `/ ${HEALTH.kcalTarget} ккал`, c: C.red, pct: (HEALTH.kcal / HEALTH.kcalTarget) * 100 },
            { l: "Шаги", v: HEALTH.steps.toLocaleString("ru"), s: `/ ${HEALTH.stepsTarget.toLocaleString("ru")}`, c: C.blue, pct: (HEALTH.steps / HEALTH.stepsTarget) * 100 },
            { l: "Сон", v: `${HEALTH.sleep} ч`, s: "/ 8 ч", c: C.violet, pct: (HEALTH.sleep / 8) * 100 },
          ].map((m, i) => (
            <div key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 12, color: C.dim }}>{m.l}</span>
                <div>
                  <Mono size={12} color={m.c}>{m.v}</Mono>
                  <span style={{ fontSize: 10, color: C.faint, marginLeft: 5 }}>{m.s}</span>
                </div>
              </div>
              <Bar_ value={m.pct} max={100} color={m.c} height={3} />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ─── ЭКРАН: КВЕСТЫ ─── */

function Quests({ quests, toggle, streak }) {
  const [sub, setSub] = useState("daily");
  const epics = [
    { title: "Трансформация тела", pct: 17, stage: "этап 4 из 24", reward: "+100 монет", color: C.green },
    { title: "На автомобиль", pct: 22, stage: "2 150 / 10 000 $", reward: "+500 монет", color: C.amber },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
        {[["daily", "Ежедневные"], ["weekly", "Недельные"], ["epic", "Эпические"]].map(([id, label]) => (
          <button key={id} onClick={() => setSub(id)} style={{
            flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 700, letterSpacing: ".06em",
            textTransform: "uppercase", color: sub === id ? C.amber : C.faint,
            borderBottom: `2px solid ${sub === id ? C.amber : "transparent"}`, marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {sub === "daily" && (
        <Panel>
          {quests.map((q, i) => {
            const sphere = SPHERES.find(s => s.id === q.sphere);
            const preview = calcBonus({
              streakDays: streak, isFocusSphere: q.sphere === FOCUS_SPHERE,
              morning: new Date().getHours() < 10, perfectDay: false,
            });
            return (
              <div key={q.id} className="row" onClick={() => toggle(q.id)} style={{
                display: "flex", alignItems: "center", gap: 11, padding: "11px 4px",
                borderBottom: i < quests.length - 1 ? `1px solid ${C.border}` : "none",
              }}>
                <div style={{
                  width: 18, height: 18, borderRadius: 2, flexShrink: 0,
                  border: `1px solid ${q.done ? C.green : C.faint}`,
                  background: q.done ? C.green : "transparent", display: "grid", placeItems: "center",
                }}>{q.done && <span style={{ color: C.bg, fontSize: 11, fontWeight: 900 }}>✓</span>}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: q.done ? C.faint : C.text, textDecoration: q.done ? "line-through" : "none" }}>{q.title}</div>
                  <div style={{ fontSize: 10, color: sphere?.color, marginTop: 2 }}>{sphere?.name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <Mono size={12} color={q.done ? C.faint : C.amber}>+{Math.round(q.baseXP * preview.multiplier)}</Mono>
                  {!q.done && preview.multiplier > 1 && (
                    <div style={{ fontSize: 9, color: C.green }}>×{preview.multiplier.toFixed(2)}</div>
                  )}
                </div>
              </div>
            );
          })}
        </Panel>
      )}

      {sub === "epic" && epics.map((e, i) => (
        <Panel key={i} accent={e.color}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{e.title}</span>
            <Mono size={13} color={e.color}>{e.pct}%</Mono>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 10 }}>{e.stage}</div>
          <Bar_ value={e.pct} max={100} color={e.color} height={6} />
          <div style={{ fontSize: 10, color: C.faint, marginTop: 8 }}>Награда: {e.reward}</div>
        </Panel>
      ))}

      {sub === "weekly" && (
        <Panel style={{ textAlign: "center", padding: 30 }}>
          <div style={{ fontSize: 12, color: C.dim }}>Недельные квесты обновятся в понедельник</div>
        </Panel>
      )}
    </div>
  );
}

/* ─── ЭКРАН: ПРОГРЕСС ─── */

function Progress({ spheresXP, onTimer, timer }) {
  const [sub, setSub] = useState("spheres");

  // Радар с минимальным радиусом + пунктирный контур цели — улучшение №8
  const radarData = SPHERES.map(s => ({
    subject: s.short,
    value: radarValue(spheresXP[s.id]),
    target: 8,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
        {[["spheres", "Сферы"], ["activities", "Активности"], ["summary", "Итоги"]].map(([id, label]) => (
          <button key={id} onClick={() => setSub(id)} style={{
            flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 700, letterSpacing: ".06em",
            textTransform: "uppercase", color: sub === id ? C.amber : C.faint,
            borderBottom: `2px solid ${sub === id ? C.amber : "transparent"}`, marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {sub === "spheres" && (
        <>
          <Panel style={{ paddingBottom: 4 }}>
            <Label>Баланс сфер</Label>
            <ResponsiveContainer width="100%" height={210}>
              <RadarChart data={radarData} outerRadius="72%">
                <PolarGrid stroke={C.border} />
                <PolarAngleAxis dataKey="subject" tick={{ fill: C.dim, fontSize: 10, fontWeight: 700 }} />
                <PolarRadiusAxis tick={false} axisLine={false} domain={[0, 10]} />
                <Radar dataKey="target" stroke={C.faint} strokeDasharray="3 3" fill="none" strokeWidth={1} />
                <Radar dataKey="value" stroke={C.amber} fill={C.amber} fillOpacity={0.14} strokeWidth={2}
                  dot={{ fill: C.amber, r: 3, strokeWidth: 0 }} />
              </RadarChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 10, color: C.faint, textAlign: "center", paddingBottom: 10 }}>
              Пунктир — ориентир равномерного развития
            </div>
          </Panel>

          {SPHERES.map((s, i) => {
            const st = sphereState(spheresXP[s.id]);
            return (
              <Panel key={s.id} accent={s.color} style={{ padding: 13, animation: `slideUp .25s ease ${i * .04}s both` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <span style={{ color: s.color, fontSize: 15 }}>{s.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                      <Mono size={11} color={s.color}>ур. {st.level}</Mono>
                    </div>
                    <Bar_ value={st.xpIntoLevel} max={st.capacity} color={s.color} height={4} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                      <Mono size={9} color={C.faint} weight={400}>{st.xpIntoLevel} / {st.capacity} XP</Mono>
                      {s.id === FOCUS_SPHERE && (
                        <span style={{ fontSize: 9, color: C.green, letterSpacing: ".06em" }}>ФОКУС НЕДЕЛИ</span>
                      )}
                    </div>
                  </div>
                </div>
              </Panel>
            );
          })}

          <Panel>
            <Label>Опыт за неделю</Label>
            <div style={{ marginTop: 12 }}>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={WEEK_XP} barSize={20}>
                  <XAxis dataKey="day" tick={{ fill: C.faint, fontSize: 9 }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <ReferenceLine y={300} stroke={C.green} strokeDasharray="2 3" />
                  <Tooltip cursor={{ fill: "#ffffff08" }}
                    contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, fontSize: 11 }}
                    formatter={(v) => [`${v} XP`, ""]} />
                  <Bar dataKey="xp" radius={[1, 1, 0, 0]}>
                    {WEEK_XP.map((d, i) => (
                      <Cell key={i} fill={d.xp === 0 ? C.border : d.xp > 500 ? C.red : d.xp > 300 ? C.amber : C.green} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 10, color: C.faint, marginTop: 6, lineHeight: 1.45 }}>
                Пунктир — порог дневного потолка. Красные столбцы: часть XP срезалась
              </div>
            </div>
          </Panel>
        </>
      )}

      {sub === "activities" && (
        <>
          <div style={{ fontSize: 10, color: C.faint, letterSpacing: ".06em" }}>
            ОКНО ПОСЛЕДНИХ 30 ДНЕЙ · НАЖМИ, ЧТОБЫ ЗАПУСТИТЬ ТАЙМЕР
          </div>
          {ACTIVITIES.map((a, i) => {
            const st = sphereState(a.xp);
            const days = a.win.filter(Boolean).length;
            const running = timer?.id === a.id;
            return (
              <Panel key={a.id} accent={running ? C.green : a.color}
                onClick={() => !timer && onTimer({ id: a.id, name: a.name, sec: 0 })}
                style={{ padding: 13, animation: `slideUp .25s ease ${i * .04}s both`, cursor: timer ? "default" : "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
                  <span style={{ color: a.color, fontSize: 14 }}>{a.icon}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{a.name}</span>
                  <Mono size={11} color={a.color}>ур. {st.level}</Mono>
                </div>
                <Window30 days={a.win} color={a.color} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                  <Mono size={10} color={C.dim} weight={400}>{days} из 30 дней</Mono>
                  <span style={{ fontSize: 10, color: a.last === 0 ? C.green : a.last <= 7 ? C.amber : C.red }}>
                    {a.last === 0 ? "сегодня" : `${a.last} дн. назад`}
                  </span>
                </div>
              </Panel>
            );
          })}
        </>
      )}

      {sub === "summary" && (
        <Panel>
          <div style={{ textAlign: "center", paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
            <Label>Титул месяца</Label>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, color: C.amber }}>Творец реальности</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: C.border, marginTop: 16 }}>
            {[
              ["4 040", "Опыта", C.amber], ["2", "Задач", C.green],
              ["2", "Тренировок", C.blue], ["0 ₸", "Доход", C.dim],
              ["5,7 ч", "Ср. сон", C.violet], ["466", "Ср. ккал", C.red],
              ["2", "Страниц", C.blue], ["12", "Лучшая серия", C.red],
            ].map(([v, l, c], i) => (
              <div key={i} style={{ background: C.surface, padding: "14px 12px" }}>
                <Mono size={17} color={c}>{v}</Mono>
                <div style={{ fontSize: 10, color: C.faint, marginTop: 3 }}>{l}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ─── ЭКРАН: МАГАЗИН ─── */

function Shop({ coins, setCoins }) {
  const [flash, setFlash] = useState(null);
  const buy = (r) => {
    if (coins < r.cost) return;
    setCoins(c => c - r.cost);
    setFlash(r.id);
    setTimeout(() => setFlash(null), 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel accent={C.amber} style={{ textAlign: "center", padding: 22 }}>
        <Label color={C.amber}>Баланс</Label>
        <div style={{ marginTop: 8 }}><Mono size={34} color={C.amber}>{coins}</Mono></div>
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>монет · +5 за каждый новый уровень</div>
      </Panel>

      {REWARDS.map(r => {
        const afford = coins >= r.cost;
        return (
          <Panel key={r.id} accent={flash === r.id ? C.green : afford ? C.amber : C.border}
            onClick={() => buy(r)}
            style={{ padding: 13, opacity: afford ? 1 : 0.45, cursor: afford ? "pointer" : "default" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 16, color: afford ? C.amber : C.faint }}>{r.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                {r.fav && <span style={{ fontSize: 9, color: C.red, letterSpacing: ".06em" }}>ЛЮБИМАЯ</span>}
              </div>
              {flash === r.id
                ? <Mono size={12} color={C.green}>КУПЛЕНО</Mono>
                : <Mono size={13} color={afford ? C.amber : C.faint}>{r.cost}</Mono>}
            </div>
          </Panel>
        );
      })}

      <div style={{ fontSize: 10, color: C.faint, lineHeight: 1.5, padding: "4px 2px" }}>
        Списание монет проверяется на стороне базы: клиент не может уйти в минус,
        даже если подделает запрос.
      </div>
    </div>
  );
}
