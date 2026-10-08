import { describe, it, expect } from 'vitest';
import { calculateBonus, applySoftCap, awardXP, MAX_BONUS } from '../lib/gamification';

const ctx = (o: Partial<Parameters<typeof calculateBonus>[0]> = {}) => ({
  streakDays: 0, isFocusSphere: false, completedBefore10am: false, isPerfectDay: false, ...o,
});

describe('Множители', () => {
  it('без бонусов множитель равен единице', () => {
    expect(calculateBonus(ctx()).multiplier).toBe(1);
  });

  it('бонусы складываются, а не перемножаются', () => {
    // Старая мультипликативная схема давала 2.0 × 1.2 × 1.1 = ×2.64.
    // Через месяц игрок получал в 2,6 раза больше за то же действие.
    const b = calculateBonus(ctx({ streakDays: 30, isFocusSphere: true, completedBefore10am: true }));
    expect(b.multiplier).toBeCloseTo(1 + 0.5 + 0.2 + 0.1, 5);
    expect(b.multiplier).toBeLessThan(2.64);
  });

  it('пороги стрика не складываются друг с другом', () => {
    // Серия 30 дней не должна давать бонусы за 7 + 14 + 30 одновременно
    const b = calculateBonus(ctx({ streakDays: 30 }));
    const streakParts = b.parts.filter(p => p.label.startsWith('Серия'));
    expect(streakParts).toHaveLength(1);
    expect(b.multiplier).toBeCloseTo(1.5, 5);
  });

  it('множитель упирается в потолок ×2.5', () => {
    const b = calculateBonus(ctx({
      streakDays: 365, isFocusSphere: true, completedBefore10am: true, isPerfectDay: true,
    }));
    expect(b.multiplier).toBeLessThanOrEqual(1 + MAX_BONUS);
    expect(b.multiplier).toBeCloseTo(1 + Math.min(0.75 + 0.2 + 0.1 + 0.25, MAX_BONUS), 5);
  });

  it('множитель монотонно растёт по длине серии', () => {
    let prev = 0;
    for (const d of [0, 7, 14, 30, 100, 500]) {
      const m = calculateBonus(ctx({ streakDays: d })).multiplier;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('разбивка объясняет итоговое число', () => {
    // Пользователь должен видеть, из чего сложился множитель
    const b = calculateBonus(ctx({ streakDays: 14, isFocusSphere: true }));
    const sum = b.parts.reduce((a, p) => a + p.value, 0);
    expect(b.multiplier).toBeCloseTo(1 + sum, 5);
  });
});

describe('Дневной потолок', () => {
  it('до 300 XP начисляется полностью', () => {
    expect(applySoftCap(0, 100).granted).toBe(100);
    expect(applySoftCap(200, 100).granted).toBe(100);
    expect(applySoftCap(0, 300).granted).toBe(300);
  });

  it('второй ярус режет вдвое, третий вчетверо', () => {
    expect(applySoftCap(300, 100).granted).toBe(50);
    expect(applySoftCap(500, 100).granted).toBe(25);
  });

  it('начисление через границу яруса делится корректно', () => {
    // 250 → 350: сто единиц по 1.0, сто по 0.5
    expect(applySoftCap(250, 200).granted).toBe(50 + 75);
  });

  it('гринд одним действием режется жёстко', () => {
    // «Залогировал кодинг 8 часов» не должен обесценить месяц работы
    const r = applySoftCap(0, 2000);
    expect(r.granted).toBeLessThan(800);
    expect(r.effectiveRate).toBeLessThan(0.4);
  });

  it('потолок нельзя обойти дроблением на мелкие порции', () => {
    // Ключевое свойство: позиция считается по СЫРОМУ XP.
    // Если бы она считалась по начисленному, игрок дробил бы
    // одно большое начисление на двадцать мелких и обходил лимит.
    const oneGo = applySoftCap(0, 1000).granted;

    let rawPos = 0, pieces = 0;
    for (let i = 0; i < 20; i++) {
      pieces += applySoftCap(rawPos, 50).granted;
      rawPos += 50;
    }
    expect(pieces).toBe(oneGo);
  });

  it('никогда не начисляет больше, чем просили', () => {
    for (const [pos, raw] of [[0, 10], [299, 5], [450, 200], [900, 50]]) {
      const r = applySoftCap(pos, raw);
      expect(r.granted).toBeLessThanOrEqual(raw);
      expect(r.granted + r.lost).toBe(raw);
    }
  });
});

describe('Итоговое начисление', () => {
  it('порядок операций: сначала бонусы, потом потолок', () => {
    // Обратный порядок дал бы игроку больше XP за счёт обхода лимита
    const a = awardXP(100, ctx({ streakDays: 30 }), 290);
    expect(a.beforeCap).toBe(150);          // 100 × 1.5
    expect(a.finalXP).toBe(10 + 70);        // 10 по полной, 140 пополам
    expect(a.softCapActive).toBe(true);
  });

  it('обычный день не упирается в потолок', () => {
    // Защита от переусердствования: семь квестов обычного дня
    // дают около 170 сырых XP — лимит ловит гринд, а не честную игру
    const base = [5, 10, 20, 25, 15, 15, 25];
    let raw = 0, granted = 0;
    for (const b of base) {
      const a = awardXP(b, ctx({ streakDays: 14, isFocusSphere: true }), raw);
      raw += a.beforeCap;
      granted += a.finalXP;
    }
    expect(raw).toBeLessThan(300);
    expect(granted).toBe(raw); // ничего не срезано
  });
});
