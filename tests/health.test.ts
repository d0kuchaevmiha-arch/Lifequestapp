import { describe, it, expect } from 'vitest';
import {
  aggregateToDays, userDateOf, findAnomalies, mergeWithManual,
  importHealth, MockHealthProvider, trustOf,
  type HealthSample,
} from '../lib/integrations/health';

const TZ = 'Asia/Almaty'; // UTC+5

const sample = (o: Partial<HealthSample> & Pick<HealthSample, 'metric' | 'value' | 'start'>): HealthSample => ({
  end: o.start, source: 'phone', ...o,
});

describe('Привязка к дню пользователя', () => {
  it('учитывает часовой пояс, а не UTC', () => {
    // 21:00 UTC — это уже следующий день в Алматы (UTC+5)
    expect(userDateOf('2026-05-14T21:00:00Z', TZ)).toBe('2026-05-15');
    expect(userDateOf('2026-05-14T21:00:00Z', 'UTC')).toBe('2026-05-14');
  });

  it('сон относится к утру пробуждения, а не к вечеру засыпания', () => {
    // Лёг во вторник в 23:40, встал в среду в 7:10 — это сон среды,
    // иначе в календаре сна появится дыра
    const days = aggregateToDays([
      sample({
        metric: 'sleep', value: 7.5,
        start: '2026-05-12T18:40:00Z',  // 23:40 местного, вторник
        end: '2026-05-13T02:10:00Z',    // 07:10 местного, среда
        source: 'apple-watch',
      }),
    ], TZ);

    expect(days).toHaveLength(1);
    expect(days[0].date).toBe('2026-05-13');
    expect(days[0].sleepHours).toBe(7.5);
  });

  it('некорректная дата выбрасывает понятную ошибку', () => {
    expect(() => userDateOf('не-дата', TZ)).toThrow(/Некорректная дата/);
  });
});

describe('Шаги: защита от двойного счёта', () => {
  it('часы и телефон не складываются', () => {
    // Главная ловушка импорта: один и тот же день, посчитанный
    // двумя устройствами. Сумма дала бы 14 500 и фальшивую медаль.
    const days = aggregateToDays([
      sample({ metric: 'steps', value: 8400, start: '2026-05-15T06:00:00Z', source: 'apple-watch' }),
      sample({ metric: 'steps', value: 6100, start: '2026-05-15T06:00:00Z', source: 'phone' }),
    ], TZ);

    expect(days[0].steps).toBe(8400);
    expect(days[0].steps).not.toBe(14500);
  });

  it('несколько записей одного устройства берутся по максимуму', () => {
    // Health Connect шлёт накопительный счётчик несколько раз за день
    const days = aggregateToDays([
      sample({ metric: 'steps', value: 3000, start: '2026-05-15T06:00:00Z', source: 'phone' }),
      sample({ metric: 'steps', value: 7200, start: '2026-05-15T12:00:00Z', source: 'phone' }),
      sample({ metric: 'steps', value: 9100, start: '2026-05-15T18:00:00Z', source: 'phone' }),
    ], TZ);
    expect(days[0].steps).toBe(9100);
  });

  it('более доверенный источник выигрывает даже с меньшим значением', () => {
    const days = aggregateToDays([
      sample({ metric: 'steps', value: 20000, start: '2026-05-15T06:00:00Z', source: 'phone' }),
      sample({ metric: 'steps', value: 9000, start: '2026-05-15T06:00:00Z', source: 'garmin' }),
    ], TZ);
    expect(days[0].steps).toBe(9000);
  });
});

describe('Остальные метрики', () => {
  it('фазы сна за одну ночь складываются', () => {
    const days = aggregateToDays([
      sample({ metric: 'sleep', value: 3.2, start: '2026-05-14T19:00:00Z', end: '2026-05-14T22:12:00Z', source: 'apple-watch' }),
      sample({ metric: 'sleep', value: 4.1, start: '2026-05-14T22:30:00Z', end: '2026-05-15T02:36:00Z', source: 'apple-watch' }),
    ], TZ);
    // Обе фазы заканчиваются 15-го по местному времени
    expect(days[0].sleepHours).toBeCloseTo(7.3, 1);
  });

  it('вес берётся последний за день', () => {
    const days = aggregateToDays([
      sample({ metric: 'weight', value: 95.4, start: '2026-05-15T03:00:00Z', source: 'mi-scale' }),
      sample({ metric: 'weight', value: 95.1, start: '2026-05-15T15:00:00Z', source: 'mi-scale' }),
    ], TZ);
    expect(days[0].weightKg).toBe(95.1);
  });

  it('пульс усредняется', () => {
    const days = aggregateToDays([
      sample({ metric: 'heartRate', value: 60, start: '2026-05-15T06:00:00Z', source: 'apple-watch' }),
      sample({ metric: 'heartRate', value: 70, start: '2026-05-15T07:00:00Z', source: 'apple-watch' }),
    ], TZ);
    expect(days[0].restingHeartRate).toBe(65);
  });

  it('отрицательные и нечисловые значения отбрасываются', () => {
    const days = aggregateToDays([
      sample({ metric: 'steps', value: -500, start: '2026-05-15T06:00:00Z' }),
      sample({ metric: 'steps', value: NaN, start: '2026-05-15T07:00:00Z' }),
      sample({ metric: 'steps', value: 5000, start: '2026-05-15T08:00:00Z' }),
    ], TZ);
    expect(days[0].steps).toBe(5000);
  });

  it('дни возвращаются в хронологическом порядке', () => {
    const days = aggregateToDays([
      sample({ metric: 'steps', value: 100, start: '2026-05-17T06:00:00Z' }),
      sample({ metric: 'steps', value: 200, start: '2026-05-15T06:00:00Z' }),
      sample({ metric: 'steps', value: 300, start: '2026-05-16T06:00:00Z' }),
    ], TZ);
    expect(days.map(d => d.date)).toEqual(['2026-05-15', '2026-05-16', '2026-05-17']);
  });

  it('пустой вход даёт пустой результат, а не падение', () => {
    expect(aggregateToDays([], TZ)).toEqual([]);
  });
});

describe('Поиск аномалий', () => {
  it('ловит вес вне физических границ', () => {
    const a = findAnomalies([{ date: '2026-05-15', weightKg: 950, sources: [] }]);
    expect(a).toHaveLength(1);
    expect(a[0].reason).toMatch(/вне диапазона/);
  });

  it('ловит скачок веса за сутки', () => {
    // Кто-то другой встал на весы — не повод рушить график
    const a = findAnomalies([
      { date: '2026-05-14', weightKg: 95.0, sources: [] },
      { date: '2026-05-15', weightKg: 102.5, sources: [] },
    ]);
    expect(a.some(x => x.reason.includes('скачок'))).toBe(true);
  });

  it('плавное снижение веса аномалией не считается', () => {
    const a = findAnomalies([
      { date: '2026-05-14', weightKg: 95.4, sources: [] },
      { date: '2026-05-15', weightKg: 95.0, sources: [] },
      { date: '2026-05-16', weightKg: 94.7, sources: [] },
    ]);
    expect(a).toHaveLength(0);
  });

  it('большая разница за длинный перерыв допустима', () => {
    // Месяц не взвешивался и похудел на 5 кг — это нормально
    const a = findAnomalies([
      { date: '2026-04-15', weightKg: 100, sources: [] },
      { date: '2026-05-15', weightKg: 95, sources: [] },
    ]);
    expect(a).toHaveLength(0);
  });

  it('ловит невозможный пульс и сон', () => {
    const a = findAnomalies([{ date: '2026-05-15', restingHeartRate: 300, sleepHours: 26, sources: [] }]);
    expect(a).toHaveLength(2);
  });
});

describe('Слияние с ручным вводом', () => {
  const imported = { date: '2026-05-15', weightKg: 95.0, steps: 8400, sources: ['mi-scale'] };

  it('ручная правка не затирается импортом', () => {
    const merged = mergeWithManual(imported, { weightKg: 94.8 });
    expect(merged.weightKg).toBe(94.8);
    expect(merged.steps).toBe(8400); // остальное сохранено
  });

  it('источник manual попадает в список', () => {
    expect(mergeWithManual(imported, { weightKg: 94.8 }).sources).toContain('manual');
  });

  it('без ручного ввода данные проходят без изменений', () => {
    expect(mergeWithManual(imported, undefined)).toEqual(imported);
  });

  it('ручной ввод имеет наивысшее доверие', () => {
    expect(trustOf('manual')).toBeGreaterThanOrEqual(trustOf('apple-watch'));
  });
});

describe('Оркестратор импорта', () => {
  const samples: HealthSample[] = [
    sample({ metric: 'steps', value: 8400, start: '2026-05-15T06:00:00Z', source: 'apple-watch' }),
    sample({ metric: 'weight', value: 95.0, start: '2026-05-15T03:00:00Z', source: 'mi-scale' }),
  ];

  it('успешный импорт возвращает дни и источник', async () => {
    const r = await importHealth(
      new MockHealthProvider(samples), ['steps', 'weight'],
      '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', TZ);

    expect(r.days).toHaveLength(1);
    expect(r.days[0].steps).toBe(8400);
    expect(r.days[0].weightKg).toBe(95);
    expect(r.skippedMetrics).toHaveLength(0);
  });

  it('недоступный источник сообщает об этом понятно', async () => {
    await expect(importHealth(
      new MockHealthProvider([], { available: false }), ['steps'],
      '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', TZ))
      .rejects.toThrow(/недоступен/);
  });

  it('отказ в доступе к метрике не роняет импорт', async () => {
    const r = await importHealth(
      new MockHealthProvider(samples, { deny: ['weight'] }), ['steps', 'weight'],
      '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', TZ);

    expect(r.days[0].steps).toBe(8400);
    expect(r.days[0].weightKg).toBeUndefined();
    expect(r.skippedMetrics).toEqual(['weight']);
  });

  it('сбой одной метрики не отменяет остальные', async () => {
    const r = await importHealth(
      new MockHealthProvider(samples, { fail: ['weight'] }), ['steps', 'weight'],
      '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', TZ);

    expect(r.days[0].steps).toBe(8400);
    expect(r.skippedMetrics).toEqual(['weight']);
  });

  it('аномалии возвращаются вместе с данными', async () => {
    const r = await importHealth(
      new MockHealthProvider([sample({ metric: 'weight', value: 999, start: '2026-05-15T03:00:00Z', source: 'mi-scale' })]),
      ['weight'], '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', TZ);

    expect(r.anomalies).toHaveLength(1);
  });
});
