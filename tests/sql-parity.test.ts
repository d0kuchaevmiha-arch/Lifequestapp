import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  levelFromXP, sphereStateFromXP, calculateBonus, applySoftCap, xpForLevel,
} from '../lib/gamification';

/**
 * Настоящая проверка SQL — без регулярных выражений.
 *
 * Схема выполняется на движке Postgres (PGlite — тот же Postgres,
 * скомпилированный в WASM, поднимать сервер не нужно). Для каждой
 * функции берём одинаковые входы, прогоняем через SQL и TypeScript
 * и требуем совпадения результатов.
 *
 * Здесь же проверяется триггер начисления XP целиком — это самая
 * хрупкая часть системы, и регулярные выражения её не покрывают.
 */

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(read('tests/sql/supabase-stubs.sql'));
  await db.exec(read('schema.sql'));
});

afterAll(async () => {
  await db?.close();
});

const scalar = async <T = number>(sql: string, params: unknown[] = []): Promise<T> => {
  const r = await db.query<Record<string, T>>(sql, params);
  return Object.values(r.rows[0])[0] as T;
};

describe('Функции уровней: SQL совпадает с TypeScript', () => {
  it('level_from_xp на сетке значений', async () => {
    for (const xp of [0, 1, 99, 100, 289, 290, 541, 1189, 4040, 10_037, 41_096, 119_378]) {
      const sql = await scalar('select level_from_xp($1)', [xp]);
      expect(sql, `xp=${xp}`).toBe(levelFromXP(xp).level);
    }
  });

  it('xp_for_level на сетке уровней', async () => {
    for (const lvl of [0, 1, 2, 5, 10, 20, 50, 100]) {
      const sql = await scalar('select xp_for_level($1)', [lvl]);
      expect(sql, `level=${lvl}`).toBe(xpForLevel(lvl));
    }
  });

  it('порог уровня: при xp_for_level(n) уровень уже n', async () => {
    // Регрессия, найденная тестами: при round порог был ниже границы
    for (let lvl = 1; lvl <= 60; lvl++) {
      const threshold = await scalar('select xp_for_level($1)', [lvl]);
      const back = await scalar('select level_from_xp($1)', [threshold]);
      expect(back, `level=${lvl}`).toBe(lvl);
    }
  });

  it('sphere_level_from_xp совпадает с TypeScript', async () => {
    for (const xp of [0, 59, 60, 139, 140, 500, 745, 4000]) {
      const sql = await scalar('select sphere_level_from_xp($1)', [xp]);
      expect(sql, `xp=${xp}`).toBe(sphereStateFromXP(xp).level);
    }
  });
});

describe('Бонусы: SQL совпадает с TypeScript', () => {
  const cases = [
    { streak: 0, focus: false, morning: false, perfect: false },
    { streak: 7, focus: false, morning: false, perfect: false },
    { streak: 14, focus: true, morning: false, perfect: false },
    { streak: 30, focus: true, morning: true, perfect: false },
    { streak: 30, focus: true, morning: true, perfect: true },
    { streak: 365, focus: true, morning: true, perfect: true },
  ];

  for (const c of cases) {
    it(`calc_bonus streak=${c.streak} focus=${c.focus} morning=${c.morning} perfect=${c.perfect}`, async () => {
      const sql = await scalar<number>(
        'select calc_bonus($1,$2,$3,$4)::float8', [c.streak, c.focus, c.morning, c.perfect]);
      const ts = calculateBonus({
        streakDays: c.streak,
        isFocusSphere: c.focus,
        completedBefore10am: c.morning,
        isPerfectDay: c.perfect,
      }).multiplier;
      expect(sql).toBeCloseTo(ts, 5);
    });
  }
});

describe('Дневной потолок: SQL совпадает с TypeScript', () => {
  it('apply_soft_cap на сетке (сырой за день × новое начисление)', async () => {
    for (const pos of [0, 100, 250, 300, 420, 500, 900]) {
      for (const raw of [1, 49, 50, 200, 1000]) {
        const sql = await scalar('select apply_soft_cap($1,$2)', [pos, raw]);
        const ts = applySoftCap(pos, raw).granted;
        expect(sql, `pos=${pos} raw=${raw}`).toBe(ts);
      }
    }
  });

  it('дробление не даёт преимущества (в SQL)', async () => {
    const oneGo = await scalar('select apply_soft_cap(0, 1000)');
    let pos = 0, pieces = 0;
    for (let i = 0; i < 20; i++) {
      pieces += await scalar('select apply_soft_cap($1, 50)', [pos]);
      pos += 50;
    }
    expect(pieces).toBe(oneGo);
  });
});

describe('Триггер начисления XP целиком', () => {
  const USER = '00000000-0000-0000-0000-000000000001';
  const QUEST_A = '00000000-0000-0000-0000-00000000000a';
  const QUEST_B = '00000000-0000-0000-0000-00000000000b';
  const SPHERE = '00000000-0000-0000-0000-0000000000c1';

  beforeAll(async () => {
    // Чистый пользователь с пустой историей. Каждый describe-блок
    // создаёт своего, чтобы тесты не влияли друг на друга.
    await db.exec(`
      insert into auth.users (id) values ('${USER}') on conflict do nothing;
      insert into profiles (id, username, focus_sphere, timezone)
        values ('${USER}', 'test', '${SPHERE}', 'Asia/Almaty') on conflict do nothing;
      insert into spheres (id, user_id, name) values ('${SPHERE}', '${USER}', 'Энергия')
        on conflict do nothing;
      insert into quests (id, user_id, sphere_id, title, type, base_xp, coin_reward)
        values
          ('${QUEST_A}', '${USER}', '${SPHERE}', 'Тренировка', 'daily', 25, 2),
          ('${QUEST_B}', '${USER}', null, 'Чтение', 'daily', 15, 0)
        on conflict do nothing;
    `);
  });

  it('первое выполнение начисляет XP, сферу и монеты', async () => {
    await db.query(
      `insert into quest_completions (quest_id, user_id, date, completed_at)
       values ($1, $2, '2026-05-15', '2026-05-15 12:00+05')`,
      [QUEST_A, USER]);

    const p = await db.query<{ total_xp: number; coins: number }>(
      'select total_xp, coins from profiles where id = $1', [USER]);
    expect(p.rows[0].total_xp).toBeGreaterThan(0);
    expect(p.rows[0].coins).toBe(2); // coin_reward квеста

    const s = await db.query<{ total_xp: number }>(
      'select total_xp from spheres where id = $1', [SPHERE]);
    expect(s.rows[0].total_xp).toBe(p.rows[0].total_xp);
  });

  it('XP в строке выполнения согласован с TypeScript', async () => {
    // Утро (до 10:00 Алматы) не в этом тесте: completed_at в 12:00.
    // Фокус-сфера даёт +20%, серия из одного дня — без бонуса.
    const r = await db.query<{ base_xp: number; raw_xp: number; xp_awarded: number; bonus_multiplier: number }>(
      `select base_xp, raw_xp, xp_awarded, bonus_multiplier
         from quest_completions where quest_id = $1 and date = '2026-05-15'`, [QUEST_A]);
    const row = r.rows[0];
    expect(row.base_xp).toBe(25);
    expect(row.bonus_multiplier).toBeCloseTo(1.2, 5);
    expect(row.raw_xp).toBe(Math.round(25 * 1.2));
    expect(row.xp_awarded).toBe(row.raw_xp); // дневной потолок ещё не сработал
  });

  it('daily_stats накапливает сырой и начисленный XP отдельно', async () => {
    await db.query(
      `insert into quest_completions (quest_id, user_id, date, completed_at)
       values ($1, $2, '2026-05-15', '2026-05-15 13:00+05')`,
      [QUEST_B, USER]);

    const d = await db.query<{ raw_xp: number; xp_earned: number; quests_done: number }>(
      `select raw_xp, xp_earned, quests_done from daily_stats
        where user_id = $1 and date = '2026-05-15'`, [USER]);
    expect(d.rows[0].quests_done).toBe(2);
    expect(d.rows[0].raw_xp).toBeGreaterThanOrEqual(d.rows[0].xp_earned);
  });

  it('когда потолок срабатывает, сырой XP больше начисленного', async () => {
    // Слабое место прежней версии теста: при отсутствии потолка raw == granted,
    // и подмена raw_xp на xp_earned оставалась незамеченной. Здесь квест
    // на 400 XP заведомо выходит за порог 300 — raw и granted обязаны разойтись.
    const BIG = '00000000-0000-0000-0000-0000000000e1';
    await db.exec(`insert into quests (id, user_id, title, type, base_xp)
                   values ('${BIG}', '${USER}', 'Марафон', 'side', 400)`);
    await db.query(
      `insert into quest_completions (quest_id, user_id, date, completed_at)
       values ($1, $2, '2026-05-17', '2026-05-17 12:00+05')`, [BIG, USER]);

    const r = await db.query<{ raw_xp: number; xp_awarded: number }>(
      `select raw_xp, xp_awarded from quest_completions where quest_id = $1`, [BIG]);
    expect(r.rows[0].raw_xp).toBe(400);
    expect(r.rows[0].xp_awarded).toBe(350); // 300 полностью + 100 по половине

    const d = await db.query<{ raw_xp: number; xp_earned: number }>(
      `select raw_xp, xp_earned from daily_stats where user_id = $1 and date = '2026-05-17'`, [USER]);
    expect(d.rows[0].raw_xp).toBe(400);
    expect(d.rows[0].xp_earned).toBe(350);
  });

  it('повторное выполнение того же квеста в тот же день запрещено', async () => {
    await expect(db.query(
      `insert into quest_completions (quest_id, user_id, date, completed_at)
       values ($1, $2, '2026-05-15', now())`,
      [QUEST_A, USER])).rejects.toThrow(/unique|duplicate/i);
  });

  it('серия растёт по дням', async () => {
    await db.query(
      `insert into quest_completions (quest_id, user_id, date, completed_at)
       values ($1, $2, '2026-05-16', '2026-05-16 12:00+05')`,
      [QUEST_A, USER]);
    const s = await db.query<{ current_streak: number }>(
      `select current_streak from streaks where user_id = $1 and quest_id = $2`,
      [USER, QUEST_A]);
    expect(s.rows[0].current_streak).toBe(2);
  });

  it('покупка не уводит баланс в минус', async () => {
    const REWARD = '00000000-0000-0000-0000-0000000000d1';
    await db.exec(`insert into rewards (id, user_id, name, cost_coins)
                   values ('${REWARD}', '${USER}', 'Снек', 999)`);
    await expect(db.query(
      `insert into reward_purchases (reward_id, user_id) values ($1, $2)`,
      [REWARD, USER])).rejects.toThrow(/Недостаточно монет/);
  });

  it('монеты не могут быть отрицательными даже прямым UPDATE', async () => {
    await expect(db.query(
      `update profiles set coins = -5 where id = $1`, [USER])).rejects.toThrow(/check|coins/i);
  });
});
