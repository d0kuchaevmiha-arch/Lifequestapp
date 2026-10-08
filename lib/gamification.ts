/**
 * LifeQuest — ядро геймификации
 *
 * Здесь собрана вся математика прогрессии. Правило: этот файл — единственный
 * источник истины по XP, уровням и стрикам. Ни один компонент не считает XP сам.
 */

// ═══════════════════════════════════════════════════════════
//  1. УРОВНИ
// ═══════════════════════════════════════════════════════════

/**
 * Показатель кривой прогрессии.
 *
 * Чем меньше — тем быстрее растут уровни на поздних этапах.
 * 0.65 подобрано так, чтобы 100-й уровень занимал ~4,5 дня, а не 10.
 */
const LEVEL_EXPONENT = 0.65;
const LEVEL_BASE = 100;

/**
 * Сколько всего XP нужно накопить, чтобы достичь уровня N.
 *
 * Аналогия: это как ступеньки лестницы, которые становятся выше,
 * но не бесконечно выше — иначе на сотой ступеньке нужен был бы кран.
 */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  // ВАЖНО: ceil, а не round. При округлении вниз порог оказывается
  // ниже настоящей границы, и игрок видит «290 / 290 XP» при
  // неповысившемся уровне. ceil гарантирует, что на показанном
  // пороге levelFromXP уже вернёт следующий уровень.
  return Math.ceil(LEVEL_BASE * Math.pow(level, 1 / LEVEL_EXPONENT));
}

export interface LevelState {
  level: number;
  xpIntoLevel: number;
  xpNeededForNext: number;
  progress: number; // 0..1
  totalXP: number;
}

/**
 * Обратная функция: по общему количеству XP вычисляем уровень и прогресс.
 * Считается напрямую, без цикла — работает одинаково быстро на 5-м и 500-м уровне.
 */
export function levelFromXP(totalXP: number): LevelState {
  const safeXP = Math.max(0, totalXP);
  const level = Math.floor(Math.pow(safeXP / LEVEL_BASE, LEVEL_EXPONENT));

  const floorXP = xpForLevel(level);
  const ceilXP = xpForLevel(level + 1);

  const xpIntoLevel = safeXP - floorXP;
  const xpNeededForNext = ceilXP - floorXP;

  return {
    level,
    xpIntoLevel,
    xpNeededForNext,
    progress: xpNeededForNext > 0 ? xpIntoLevel / xpNeededForNext : 0,
    totalXP: safeXP,
  };
}

// ═══════════════════════════════════════════════════════════
//  2. СФЕРЫ ЖИЗНИ
// ═══════════════════════════════════════════════════════════

/**
 * Ёмкость уровня сферы. Одинаковая формула для всех сфер —
 * раньше «Дело» требовало 120 XP, а остальные 60, и было непонятно почему.
 *
 * Уровень 0 → 60 XP, уровень 1 → 80 XP, уровень 5 → 160 XP.
 */
export function sphereCapacity(sphereLevel: number): number {
  return 60 + 20 * Math.max(0, sphereLevel);
}

export interface SphereState {
  level: number;
  xpIntoLevel: number;
  capacity: number;
  progress: number;
}

export function sphereStateFromXP(sphereTotalXP: number): SphereState {
  let level = 0;
  let remaining = Math.max(0, sphereTotalXP);

  while (remaining >= sphereCapacity(level)) {
    remaining -= sphereCapacity(level);
    level++;
    if (level > 999) break; // страховка от бесконечного цикла
  }

  const capacity = sphereCapacity(level);
  return {
    level,
    xpIntoLevel: remaining,
    capacity,
    progress: remaining / capacity,
  };
}

// ═══════════════════════════════════════════════════════════
//  3. МНОЖИТЕЛИ (аддитивные, а не мультипликативные)
// ═══════════════════════════════════════════════════════════

/**
 * Раньше бонусы перемножались: 2.0 × 1.2 × 1.1 = ×2.64.
 * Через месяц игрок получал в 2,6 раза больше за то же действие — инфляция.
 *
 * Теперь бонусы складываются, как надбавки к зарплате:
 * оклад + 50% за стаж + 20% за проект = 170% оклада, а не 264%.
 */
export const BONUS = {
  STREAK_7: 0.15,
  STREAK_14: 0.3,
  STREAK_30: 0.5,
  STREAK_100: 0.75,
  FOCUS_SPHERE: 0.2,
  MORNING: 0.1,
  PERFECT_DAY: 0.25, // все дневные квесты закрыты
} as const;

/** Жёсткий предел суммарной надбавки — иначе поздние игроки ломают экономику. */
export const MAX_BONUS = 1.5; // максимум ×2.5 от базы

export interface BonusContext {
  streakDays: number;
  isFocusSphere: boolean;
  completedBefore10am: boolean;
  isPerfectDay: boolean;
}

export interface BonusBreakdown {
  multiplier: number;
  parts: Array<{ label: string; value: number }>;
  capped: boolean;
}

/**
 * Возвращает не только число, но и разбивку — чтобы показать пользователю,
 * из чего сложился множитель. Прозрачность = доверие к системе.
 */
export function calculateBonus(ctx: BonusContext): BonusBreakdown {
  const parts: Array<{ label: string; value: number }> = [];

  if (ctx.streakDays >= 100) parts.push({ label: 'Серия 100+ дней', value: BONUS.STREAK_100 });
  else if (ctx.streakDays >= 30) parts.push({ label: 'Серия 30+ дней', value: BONUS.STREAK_30 });
  else if (ctx.streakDays >= 14) parts.push({ label: 'Серия 14+ дней', value: BONUS.STREAK_14 });
  else if (ctx.streakDays >= 7) parts.push({ label: 'Серия 7+ дней', value: BONUS.STREAK_7 });

  if (ctx.isFocusSphere) parts.push({ label: 'Фокус недели', value: BONUS.FOCUS_SPHERE });
  if (ctx.completedBefore10am) parts.push({ label: 'Раннее утро', value: BONUS.MORNING });
  if (ctx.isPerfectDay) parts.push({ label: 'Идеальный день', value: BONUS.PERFECT_DAY });

  const rawSum = parts.reduce((acc, p) => acc + p.value, 0);
  const capped = rawSum > MAX_BONUS;
  const finalSum = Math.min(rawSum, MAX_BONUS);

  return {
    multiplier: 1 + finalSum,
    parts,
    capped,
  };
}

// ═══════════════════════════════════════════════════════════
//  4. ДНЕВНОЙ ПОТОЛОК (soft cap)
// ═══════════════════════════════════════════════════════════

/**
 * Без потолка можно за вечер залогировать «кодинг 8 часов» и получить 5000 XP,
 * обесценив месяц честной работы.
 *
 * Работает как прогрессивный подоходный налог: первые 300 XP — полностью,
 * следующие 200 — вполовину, дальше — четверть.
 */
const SOFT_CAP_TIERS = [
  { threshold: 300, rate: 1.0 },
  { threshold: 500, rate: 0.5 },
  { threshold: Infinity, rate: 0.25 },
];

export interface SoftCapResult {
  granted: number;
  lost: number;
  effectiveRate: number;
}

/**
 * ВАЖНО: `rawEarnedToday` — это сумма XP *до* применения потолка.
 *
 * Если хранить уже урезанное значение, потолок обходится:
 * заработал 1000 сырых → получил 525 → система думает, что ты на отметке 525
 * → следующие 100 XP снова идут по полной ставке. В БД для этого отдельная
 * колонка `daily_stats.raw_xp` рядом с `xp_earned`.
 *
 * @param rawEarnedToday сумма сырого XP за сегодня (до потолка)
 * @param rawXP сколько хотим начислить сейчас (после бонусов, до потолка)
 */
/**
 * Сколько XP всего начислено бы за `rawTotal` сырого XP за день.
 * Точное значение без округления.
 */
function cumulativeGranted(rawTotal: number): number {
  let position = 0;
  let acc = 0;
  for (const tier of SOFT_CAP_TIERS) {
    if (rawTotal <= position) break;
    const take = Math.min(rawTotal, tier.threshold) - position;
    acc += take * tier.rate;
    position += take;
  }
  return acc;
}

export function applySoftCap(rawEarnedToday: number, rawXP: number): SoftCapResult {
  const before = Math.max(0, rawEarnedToday);

  // Разность двух накопительных значений, а не независимый расчёт порции.
  //
  // Если округлять каждое начисление отдельно, ошибки копятся: двадцать
  // действий по 50 XP давали 530, а одно на 1000 — 525. Игрок, дробящий
  // активность на мелкие записи, получал бы больше. Разность накопительной
  // функции телескопируется: сумма по любому разбиению даёт один результат.
  const granted =
    Math.round(cumulativeGranted(before + rawXP)) - Math.round(cumulativeGranted(before));

  return {
    granted,
    lost: rawXP - granted,
    effectiveRate: rawXP > 0 ? granted / rawXP : 1,
  };
}

// ═══════════════════════════════════════════════════════════
//  5. ИТОГОВЫЙ РАСЧЁТ НАЧИСЛЕНИЯ
// ═══════════════════════════════════════════════════════════

export interface XPAward {
  baseXP: number;
  bonusMultiplier: number;
  bonusParts: Array<{ label: string; value: number }>;
  beforeCap: number;
  finalXP: number;
  lostToCap: number;
  softCapActive: boolean;
}

/**
 * Единственная точка начисления XP в приложении.
 * Порядок важен: сначала бонусы, потом потолок.
 *
 * @param rawEarnedToday сырой XP за сегодня из `daily_stats.raw_xp`
 */
export function awardXP(
  baseXP: number,
  ctx: BonusContext,
  rawEarnedToday: number
): XPAward {
  const bonus = calculateBonus(ctx);
  const beforeCap = Math.round(baseXP * bonus.multiplier);
  const cap = applySoftCap(rawEarnedToday, beforeCap);

  return {
    baseXP,
    bonusMultiplier: bonus.multiplier,
    bonusParts: bonus.parts,
    beforeCap,
    finalXP: cap.granted,
    lostToCap: cap.lost,
    softCapActive: cap.effectiveRate < 1,
  };
}

// ═══════════════════════════════════════════════════════════
//  6. СТРИКИ (с заморозками и щадящим падением)
// ═══════════════════════════════════════════════════════════

export const STREAK_CONFIG = {
  FREEZES_PER_MONTH: 2,
  /** При пропуске стрик не обнуляется, а откатывается на столько дней. */
  GRACE_PENALTY_DAYS: 3,
  /** Ниже этого порога пропуск обнуляет стрик полностью — защита от накрутки. */
  GRACE_MIN_STREAK: 7,
} as const;

export interface StreakState {
  current: number;
  longest: number;
  freezesLeft: number;
  lastCompletedDate: string | null; // 'YYYY-MM-DD'
}

export type StreakOutcome =
  | { type: 'continued'; state: StreakState }
  | { type: 'same_day'; state: StreakState }
  | { type: 'frozen'; state: StreakState; daysSkipped: number }
  | { type: 'grace_penalty'; state: StreakState; lost: number }
  | { type: 'reset'; state: StreakState; lost: number };

function daysBetween(a: string, b: string): number {
  const msPerDay = 86_400_000;
  const dateA = Date.parse(a + 'T00:00:00Z');
  const dateB = Date.parse(b + 'T00:00:00Z');
  return Math.round((dateB - dateA) / msPerDay);
}

/**
 * Пересчёт стрика при отметке квеста.
 *
 * Ключевая идея: один пропущенный день не должен обнулять месяц работы.
 * Сначала тратим заморозку, если её нет — откат на 3 дня вместо нуля.
 */
export function updateStreak(state: StreakState, today: string): StreakOutcome {
  if (!state.lastCompletedDate) {
    const next = { ...state, current: 1, longest: Math.max(state.longest, 1), lastCompletedDate: today };
    return { type: 'continued', state: next };
  }

  const gap = daysBetween(state.lastCompletedDate, today);

  // Уже отмечались сегодня
  if (gap === 0) {
    return { type: 'same_day', state };
  }

  // Идеальное продолжение
  if (gap === 1) {
    const current = state.current + 1;
    return {
      type: 'continued',
      state: { ...state, current, longest: Math.max(state.longest, current), lastCompletedDate: today },
    };
  }

  const daysSkipped = gap - 1;

  // Пробуем закрыть пропуск заморозками
  if (state.freezesLeft >= daysSkipped) {
    const current = state.current + 1;
    return {
      type: 'frozen',
      daysSkipped,
      state: {
        ...state,
        current,
        longest: Math.max(state.longest, current),
        freezesLeft: state.freezesLeft - daysSkipped,
        lastCompletedDate: today,
      },
    };
  }

  // Заморозок не хватило — щадящее падение для длинных серий
  if (state.current >= STREAK_CONFIG.GRACE_MIN_STREAK) {
    const penalty = STREAK_CONFIG.GRACE_PENALTY_DAYS * daysSkipped;
    const current = Math.max(1, state.current - penalty);
    return {
      type: 'grace_penalty',
      lost: state.current - current,
      state: { ...state, current, lastCompletedDate: today },
    };
  }

  // Короткая серия — полный сброс
  return {
    type: 'reset',
    lost: state.current,
    state: { ...state, current: 1, lastCompletedDate: today },
  };
}

/** Вызывается кроном первого числа месяца. */
export function refillFreezes(state: StreakState): StreakState {
  return { ...state, freezesLeft: STREAK_CONFIG.FREEZES_PER_MONTH };
}

// ═══════════════════════════════════════════════════════════
//  7. ВСПОМОГАТЕЛЬНОЕ
// ═══════════════════════════════════════════════════════════

/** Локальная дата в формате YYYY-MM-DD (без сдвига часового пояса). */
export function todayISO(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Нормализация значения для радарной диаграммы.
 * Минимальный радиус 15% — иначе при нулевых сферах пятиугольник
 * вырождается в точку и выглядит как ошибка рендеринга.
 */
export function radarValue(sphereXP: number, maxScale = 10): number {
  const { level, progress } = sphereStateFromXP(sphereXP);
  const raw = (level + progress) / maxScale;
  return Math.max(0.15, Math.min(1, raw)) * maxScale;
}
