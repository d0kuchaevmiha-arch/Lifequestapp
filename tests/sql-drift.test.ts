import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BONUS, MAX_BONUS, STREAK_CONFIG, sphereCapacity, xpForLevel } from '../lib/gamification';

/**
 * Математика геймификации живёт в двух местах: lib/gamification.ts
 * (для мгновенного отклика интерфейса) и SQL-функциях (как источник
 * истины, который клиент не может обойти).
 *
 * Это осознанное дублирование, и его главный риск — поправить одно
 * и забыть другое. Тогда интерфейс покажет +45 XP, а база начислит +30,
 * и пользователь решит, что приложение его обманывает.
 *
 * Тесты ниже парсят schema.sql и сверяют числа с TypeScript.
 */

const SCHEMA_PATH = resolve(__dirname, '../schema.sql');
const sql = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : '';

/** Вытаскивает тело функции по имени */
function fnBody(name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${name}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    'i'
  );
  return sql.match(re)?.[1] ?? '';
}

describe('Расхождение формул между TypeScript и SQL', () => {
  it('schema.sql находится и содержит функции геймификации', () => {
    expect(sql.length).toBeGreaterThan(0);
    for (const fn of ['level_from_xp', 'xp_for_level', 'sphere_capacity', 'calc_bonus', 'apply_soft_cap']) {
      expect(fnBody(fn), `функция ${fn} не найдена`).not.toBe('');
    }
  });

  it('показатель кривой уровней совпадает', () => {
    const body = fnBody('level_from_xp');

    // Берём последний аргумент power(...) — вложенные скобки внутри
    // greatest(p_xp, 0) ломают наивный разбор по первой запятой
    const exponent = body.match(/power\(.*,\s*([\d.]+)\s*\)/)?.[1];
    expect(exponent, `не нашёл показатель в: ${body.trim()}`).toBe('0.65');

    // И база — та же сотня
    expect(body).toMatch(/\/\s*100/);
  });

  it('обратная функция в SQL использует те же числа', () => {
    const body = fnBody('xp_for_level');
    expect(body).toMatch(/100\s*\*\s*power/);
    expect(body).toMatch(/1\s*\/\s*0\.65/);
  });

  it('ёмкость сферы: 60 + 20 × уровень', () => {
    const body = fnBody('sphere_capacity');
    const m = body.match(/(\d+)\s*\+\s*(\d+)\s*\*/);
    expect(m).not.toBeNull();
    const [, base, step] = m!;

    // Сверяем с TypeScript напрямую, а не с магическими числами
    expect(Number(base)).toBe(sphereCapacity(0));
    expect(Number(step)).toBe(sphereCapacity(1) - sphereCapacity(0));
  });

  it('пороги и величины бонусов совпадают', () => {
    const body = fnBody('calc_bonus');
    const pairs: Array<[number, number]> = [
      [100, BONUS.STREAK_100],
      [30, BONUS.STREAK_30],
      [14, BONUS.STREAK_14],
      [7, BONUS.STREAK_7],
    ];
    for (const [threshold, value] of pairs) {
      const re = new RegExp(`>=\\s*${threshold}\\s+then\\s+([\\d.]+)`, 'i');
      const found = body.match(re)?.[1];
      expect(Number(found), `порог серии ${threshold}`).toBeCloseTo(value, 5);
    }
  });

  it('бонусы фокуса, утра и идеального дня совпадают', () => {
    const body = fnBody('calc_bonus');
    const nums = [...body.matchAll(/then\s+([\d.]+)\s+else\s+0\s+end/gi)].map(m => Number(m[1]));
    expect(nums).toContain(BONUS.FOCUS_SPHERE);
    expect(nums).toContain(BONUS.MORNING);
    expect(nums).toContain(BONUS.PERFECT_DAY);
  });

  it('потолок множителя совпадает', () => {
    const body = fnBody('calc_bonus');
    const least = body.match(/least\s*\(\s*([\d.]+)/)?.[1];
    expect(Number(least)).toBeCloseTo(MAX_BONUS, 5);
  });

  it('ярусы дневного потолка совпадают', () => {
    const body = fnBody('cumulative_granted');
    // Пороги 300 и 500
    expect(body).toMatch(/300/);
    expect(body).toMatch(/500/);
    // Ставки 1.0, 0.5, 0.25
    const rates = [...body.matchAll(/\*\s*(1\.0|0\.5|0\.25)\b/g)].map(m => m[1]);
    expect(new Set(rates)).toEqual(new Set(['1.0', '0.5', '0.25']));
  });

  it('SQL считает потолок как разность накопительных значений', () => {
    // Защита от возврата к поярусному расчёту, который накапливал
    // ошибку округления и позволял обойти лимит дроблением
    const body = fnBody('apply_soft_cap');
    expect(body).toMatch(/cumulative_granted/);
    expect(body.match(/cumulative_granted/g)!.length).toBe(2);
    expect(body).toMatch(/-\s*round/);
  });

  it('параметры стриков совпадают', () => {
    const body = fnBody('update_streak');
    // Штраф за пропуск
    const penalty = body.match(/current_streak\s*-\s*(\d+)\s*\*/)?.[1];
    expect(Number(penalty)).toBe(STREAK_CONFIG.GRACE_PENALTY_DAYS);
    // Минимальная серия для щадящего режима
    expect(body).toMatch(new RegExp(`>=\\s*${STREAK_CONFIG.GRACE_MIN_STREAK}`));
  });

  it('количество заморозок в месяц совпадает', () => {
    expect(sql).toMatch(new RegExp(`freezes_left\\s+integer[^,]*default\\s+${STREAK_CONFIG.FREEZES_PER_MONTH}`, 'i'));
    expect(sql).toMatch(new RegExp(`set\\s+freezes_left\\s*=\\s*${STREAK_CONFIG.FREEZES_PER_MONTH}`, 'i'));
  });
});

describe('Защита схемы от типовых ошибок', () => {
  it('daily_stats хранит сырой XP отдельно от начисленного', () => {
    // Без отдельной колонки raw_xp потолок обходится дроблением
    expect(sql).toMatch(/raw_xp\s+integer/i);
    expect(sql).toMatch(/xp_earned\s+integer/i);
  });

  it('потолок в триггере считается от сырого XP', () => {
    const body = fnBody('on_quest_completed');
    expect(body).toMatch(/raw_xp/);
    expect(body).toMatch(/apply_soft_cap\s*\(\s*v_raw_today/);
  });

  it('повторное выполнение квеста за день невозможно', () => {
    expect(sql).toMatch(/unique\s*\(\s*quest_id\s*,\s*date\s*\)/i);
  });

  it('баланс монет не может уйти в минус', () => {
    expect(sql).toMatch(/coins\s+integer[^,]*check\s*\(\s*coins\s*>=\s*0\s*\)/i);
    expect(fnBody('on_reward_purchase')).toMatch(/raise\s+exception/i);
  });

  it('RLS включён для всех пользовательских таблиц', () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/auth\.uid\(\)/);
  });
});
