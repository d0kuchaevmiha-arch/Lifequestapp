import { describe, it, expect } from 'vitest';
import {
  awardXP, levelFromXP, updateStreak, refillFreezes,
  type StreakState,
} from '../lib/gamification';

/**
 * Симуляция месяца игры.
 *
 * Это не юнит-тест, а страховка от незаметного перекоса баланса:
 * если кто-то поправит LEVEL_EXPONENT или пороги бонусов, здесь
 * сразу станет видно, что темп прогрессии уехал.
 */

const DAILY_QUESTS = [
  { base: 5, focus: true },   // взвеситься
  { base: 10, focus: true },  // питание
  { base: 20, focus: true },  // шаги
  { base: 25, focus: true },  // тренировка
  { base: 15, focus: false }, // чтение
  { base: 15, focus: false }, // уборка
  { base: 25, focus: false }, // кодинг
];

interface SimResult {
  totalXP: number;
  level: number;
  finalStreak: number;
  longestStreak: number;
  freezesLeft: number;
  dailyGranted: number[];
  cappedDays: number;
}

function simulate(days: number, skipDays: number[] = []): SimResult {
  let totalXP = 0;
  let streak: StreakState = { current: 0, longest: 0, freezesLeft: 2, lastCompletedDate: null };
  const dailyGranted: number[] = [];
  let cappedDays = 0;

  const start = new Date('2026-01-01T00:00:00Z');
  const iso = (d: number) => new Date(start.getTime() + d * 86_400_000).toISOString().slice(0, 10);

  for (let day = 0; day < days; day++) {
    if (skipDays.includes(day + 1)) { dailyGranted.push(0); continue; }

    const outcome = updateStreak(streak, iso(day));
    streak = outcome.state;

    let rawToday = 0, grantedToday = 0, cappedHere = false;
    DAILY_QUESTS.forEach((q, i) => {
      const award = awardXP(q.base, {
        streakDays: streak.current,
        isFocusSphere: q.focus,
        completedBefore10am: false,
        isPerfectDay: i === DAILY_QUESTS.length - 1,
      }, rawToday);
      rawToday += award.beforeCap;
      grantedToday += award.finalXP;
      if (award.softCapActive) cappedHere = true;
    });

    if (cappedHere) cappedDays++;
    totalXP += grantedToday;
    dailyGranted.push(grantedToday);
  }

  return {
    totalXP,
    level: levelFromXP(totalXP).level,
    finalStreak: streak.current,
    longestStreak: streak.longest,
    freezesLeft: streak.freezesLeft,
    dailyGranted,
    cappedDays,
  };
}

describe('Симуляция 30 дней — честная игра', () => {
  const sim = simulate(30, [9, 19]);

  it('за месяц игрок доходит до уровня 10-12', () => {
    // Реперная точка: у пользователя в Obsidian было 4040 XP за
    // сопоставимый период. Выход за коридор = баланс уехал.
    expect(sim.level).toBeGreaterThanOrEqual(10);
    expect(sim.level).toBeLessThanOrEqual(12);
  });

  it('суммарный XP остаётся в разумном коридоре', () => {
    expect(sim.totalXP).toBeGreaterThan(3500);
    expect(sim.totalXP).toBeLessThan(5500);
  });

  it('средний темп около 150-200 XP в день', () => {
    const active = sim.dailyGranted.filter(x => x > 0);
    const avg = active.reduce((a, b) => a + b, 0) / active.length;
    expect(avg).toBeGreaterThan(130);
    expect(avg).toBeLessThan(220);
  });

  it('потолок ни разу не срабатывает при честной игре', () => {
    // Если этот тест упадёт, значит лимит начал наказывать
    // обычных игроков вместо гриндеров — порог надо поднимать
    expect(sim.cappedDays).toBe(0);
  });

  it('дневной доход не падает со временем', () => {
    const first = sim.dailyGranted[0];
    const last = sim.dailyGranted[sim.dailyGranted.length - 1];
    expect(last).toBeGreaterThanOrEqual(first);
  });
});

describe('Симуляция — поведение при пропусках', () => {
  it('первый пропуск съедает заморозку и не рвёт серию', () => {
    const sim = simulate(15, [9]);
    expect(sim.freezesLeft).toBe(1);
    expect(sim.finalStreak).toBeGreaterThan(10); // серия продолжилась
  });

  it('пропуск без заморозок откатывает серию, но не обнуляет', () => {
    const sim = simulate(30, [5, 12, 20]); // три пропуска, заморозок две
    expect(sim.freezesLeft).toBe(0);
    expect(sim.finalStreak).toBeGreaterThan(1); // не в ноль
  });

  it('идеальный месяц без пропусков даёт больше, чем с пропусками', () => {
    expect(simulate(30).totalXP).toBeGreaterThan(simulate(30, [9, 19]).totalXP);
  });

  it('один пропуск стоит меньше 15% месячного прогресса', () => {
    // Наказание должно быть ощутимым, но не катастрофическим —
    // иначе человек бросает приложение после первой осечки
    const perfect = simulate(30).totalXP;
    const withSkip = simulate(30, [15]).totalXP;
    expect((perfect - withSkip) / perfect).toBeLessThan(0.15);
  });
});

describe('Стрики — граничные случаи', () => {
  const base: StreakState = { current: 0, longest: 0, freezesLeft: 2, lastCompletedDate: null };

  it('первая отметка начинает серию с единицы', () => {
    const r = updateStreak(base, '2026-01-01');
    expect(r.type).toBe('continued');
    expect(r.state.current).toBe(1);
  });

  it('повторная отметка в тот же день ничего не меняет', () => {
    const s = { ...base, current: 5, lastCompletedDate: '2026-01-05' };
    const r = updateStreak(s, '2026-01-05');
    expect(r.type).toBe('same_day');
    expect(r.state.current).toBe(5);
  });

  it('пропуск при длинной серии откатывает на 3 дня, а не в ноль', () => {
    const s = { ...base, current: 20, freezesLeft: 0, lastCompletedDate: '2026-01-20' };
    const r = updateStreak(s, '2026-01-22'); // пропущен 21-й
    expect(r.type).toBe('grace_penalty');
    expect(r.state.current).toBe(17);
  });

  it('короткая серия без заморозок сбрасывается полностью', () => {
    // Защита от накрутки: щадящий режим только для заслуженных серий
    const s = { ...base, current: 3, freezesLeft: 0, lastCompletedDate: '2026-01-03' };
    const r = updateStreak(s, '2026-01-06');
    expect(r.type).toBe('reset');
    expect(r.state.current).toBe(1);
  });

  it('рекорд серии не уменьшается при откате', () => {
    const s = { ...base, current: 20, longest: 20, freezesLeft: 0, lastCompletedDate: '2026-01-20' };
    const r = updateStreak(s, '2026-01-23');
    expect(r.state.longest).toBe(20);
    expect(r.state.current).toBeLessThan(20);
  });

  it('заморозки восстанавливаются месячным кроном', () => {
    const spent = { ...base, freezesLeft: 0, current: 40 };
    const r = refillFreezes(spent);
    expect(r.freezesLeft).toBe(2);
    expect(r.current).toBe(40); // серия не тронута
  });

  it('длинный разрыв не уводит серию в отрицательные значения', () => {
    const s = { ...base, current: 10, freezesLeft: 0, lastCompletedDate: '2026-01-10' };
    const r = updateStreak(s, '2026-03-01'); // 50 дней простоя
    expect(r.state.current).toBeGreaterThanOrEqual(1);
  });
});
