import { describe, it, expect } from 'vitest';
import { xpForLevel, levelFromXP, sphereCapacity, sphereStateFromXP, radarValue } from '../lib/gamification';

describe('Уровни персонажа', () => {
  it('нулевой и отрицательный XP не ломают расчёт', () => {
    expect(levelFromXP(0).level).toBe(0);
    expect(levelFromXP(-500).level).toBe(0);
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(-3)).toBe(0);
  });

  it('levelFromXP — точная обратная функция к xpForLevel', () => {
    // Если эти две функции разъедутся, прогресс-бар будет врать
    for (let lvl = 1; lvl <= 120; lvl++) {
      const atThreshold = xpForLevel(lvl);
      expect(levelFromXP(atThreshold).level).toBe(lvl);
      expect(levelFromXP(atThreshold - 1).level).toBe(lvl - 1);
    }
  });

  it('прогресс внутри уровня всегда в диапазоне 0..1', () => {
    for (const xp of [1, 99, 100, 777, 4040, 50_000, 999_999]) {
      const s = levelFromXP(xp);
      expect(s.progress).toBeGreaterThanOrEqual(0);
      expect(s.progress).toBeLessThan(1);
      expect(s.xpIntoLevel).toBeLessThan(s.xpNeededForNext);
    }
  });

  it('калибровка по реальным данным: 4040 XP ≈ уровень 10-11', () => {
    // В Obsidian-системе у пользователя было 4040 XP и уровень 10.
    // Если правка формулы уведёт значение за этот коридор — перенос
    // прогресса сломает ощущение от системы.
    const lvl = levelFromXP(4040).level;
    expect(lvl).toBeGreaterThanOrEqual(10);
    expect(lvl).toBeLessThanOrEqual(12);
  });

  it('прирост за уровень растёт, но замедляется', () => {
    // Главный дефект старой квадратичной формулы: прирост рос линейно
    // и без предела, на 100-м уровне один уровень занимал 10 дней.
    const delta = (l: number) => xpForLevel(l + 1) - xpForLevel(l);

    expect(delta(50)).toBeGreaterThan(delta(10));      // всё ещё растёт
    expect(delta(100) / delta(50)).toBeLessThan(1.8);  // но не взрывается

    // Вторая производная отрицательная — кривая выполаживается
    const d10 = delta(20) - delta(10);
    const d90 = delta(100) - delta(90);
    expect(d90).toBeLessThan(d10);
  });

  it('на 100-м уровне один уровень стоит меньше 2000 XP', () => {
    // ~12 дней при реальном темпе 157 XP/день. Выше этого — игрок
    // перестаёт видеть прогресс и отваливается.
    expect(xpForLevel(101) - xpForLevel(100)).toBeLessThan(2000);
  });
});

describe('Сферы жизни', () => {
  it('ёмкость одинакова для всех сфер и растёт линейно', () => {
    // Раньше «Дело» требовало 120 XP, остальные 60 — без объяснений
    expect(sphereCapacity(0)).toBe(60);
    expect(sphereCapacity(1)).toBe(80);
    expect(sphereCapacity(5)).toBe(160);
    expect(sphereCapacity(-1)).toBe(60);
  });

  it('накопленный XP раскладывается в уровень без потерь', () => {
    for (const xp of [0, 59, 60, 61, 140, 500, 4000]) {
      const s = sphereStateFromXP(xp);
      let consumed = 0;
      for (let l = 0; l < s.level; l++) consumed += sphereCapacity(l);
      expect(consumed + s.xpIntoLevel).toBe(xp);
      expect(s.xpIntoLevel).toBeLessThan(s.capacity);
    }
  });

  it('ровно на границе уровень повышается', () => {
    expect(sphereStateFromXP(59).level).toBe(0);
    expect(sphereStateFromXP(60).level).toBe(1);
    expect(sphereStateFromXP(139).level).toBe(1);
    expect(sphereStateFromXP(140).level).toBe(2);
  });
});

describe('Радарная диаграмма', () => {
  it('нулевая сфера не схлопывает радар в точку', () => {
    // При уровнях 0-9-2-0-0 пятиугольник вырождался в линию
    // и выглядел как баг рендеринга, а не как данные
    expect(radarValue(0)).toBeGreaterThanOrEqual(1.5);
  });

  it('значение не выходит за пределы шкалы', () => {
    expect(radarValue(999_999)).toBeLessThanOrEqual(10);
    expect(radarValue(0)).toBeGreaterThan(0);
  });

  it('больше XP — больше радиус', () => {
    expect(radarValue(5000)).toBeGreaterThan(radarValue(500));
  });
});
