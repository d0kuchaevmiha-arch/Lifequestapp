/**
 * LifeQuest — импорт данных здоровья
 *
 * Задача: убрать ручной ввод веса, шагов и сна. Это главная причина,
 * по которой трекеры забрасывают: три минуты рутины каждый вечер
 * выдерживают две недели, потом человек бросает.
 *
 * Платформенные API различаются (Apple HealthKit, Android Health Connect),
 * поэтому здесь описан единый интерфейс, а конкретные обёртки его реализуют.
 * Вся грязная работа — дедупликация, конфликты источников, часовые пояса —
 * живёт тут и покрыта тестами, а не разъезжается по двум нативным мостам.
 */

// ═══════════════════════════════════════════════════════════
//  ТИПЫ
// ═══════════════════════════════════════════════════════════

export type HealthMetric = 'weight' | 'steps' | 'sleep' | 'calories' | 'heartRate';

export interface HealthSample {
  metric: HealthMetric;
  /** Значение в канонических единицах: кг, шаги, часы, ккал, уд/мин */
  value: number;
  /** Начало измерения, ISO 8601 с зоной */
  start: string;
  /** Конец измерения. Для мгновенных замеров совпадает с началом */
  end: string;
  /** Откуда пришло: 'apple-watch', 'mi-scale', 'manual' и т.п. */
  source: string;
  /** Насколько источнику можно верить при конфликте, 0..1 */
  confidence?: number;
}

export interface DailyHealth {
  date: string;           // YYYY-MM-DD в часовом поясе пользователя
  weightKg?: number;
  steps?: number;
  sleepHours?: number;
  activeCalories?: number;
  restingHeartRate?: number;
  /** Какие источники участвовали — для отображения «данные с Apple Watch» */
  sources: string[];
}

export interface HealthProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  requestPermissions(metrics: HealthMetric[]): Promise<HealthMetric[]>;
  /** Выборки за период. Границы включительные по дате пользователя */
  query(metric: HealthMetric, fromISO: string, toISO: string): Promise<HealthSample[]>;
}

// ═══════════════════════════════════════════════════════════
//  ПРИОРИТЕТ ИСТОЧНИКОВ
// ═══════════════════════════════════════════════════════════

/**
 * Когда один день описан несколькими устройствами, нужно решить, кому верить.
 *
 * Пример из жизни: часы насчитали 8 400 шагов, телефон в кармане — 6 100.
 * Это не два разных дня, а одно и то же, посчитанное дважды. Складывать
 * нельзя — получится 14 500 и фальшивая медаль.
 */
const SOURCE_TRUST: Record<string, number> = {
  'apple-watch': 0.95,
  'health-connect': 0.9,
  'garmin': 0.9,
  'fitbit': 0.85,
  'mi-scale': 0.9,
  'phone': 0.6,
  'manual': 1.0,     // введённое руками побеждает: человек знает лучше
};

export function trustOf(source: string): number {
  return SOURCE_TRUST[source] ?? 0.5;
}

// ═══════════════════════════════════════════════════════════
//  ЧАСОВЫЕ ПОЯСА
// ═══════════════════════════════════════════════════════════

/**
 * К какому дню пользователя относится измерение.
 *
 * Критично для сна: человек лёг в 23:40 во вторник и встал в 7:10 в среду.
 * Этот сон принадлежит среде — тому утру, когда он проснулся, иначе
 * в календаре появится дыра.
 */
export function userDateOf(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректная дата: ${iso}`);
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// ═══════════════════════════════════════════════════════════
//  СВЁРТКА ВЫБОРОК В ДНИ
// ═══════════════════════════════════════════════════════════

/** Как сворачивать метрику за день */
const AGGREGATION: Record<HealthMetric, 'sum' | 'last' | 'max' | 'avg'> = {
  steps: 'max',          // не сумма! иначе часы + телефон дадут двойной счёт
  calories: 'max',
  sleep: 'sum',          // несколько фаз сна складываются
  weight: 'last',        // вес берём последний за день
  heartRate: 'avg',
};

interface Bucket { samples: HealthSample[] }

/**
 * Превращает сырой поток выборок в дневную сводку.
 *
 * Шаги алгоритма:
 *  1. Разложить по дням в часовом поясе пользователя
 *  2. Внутри дня сгруппировать по источнику
 *  3. Свернуть каждый источник по своему правилу
 *  4. При конфликте выбрать самый доверенный источник
 */
export function aggregateToDays(
  samples: HealthSample[],
  timeZone: string
): DailyHealth[] {
  const byDate = new Map<string, Map<HealthMetric, Bucket>>();

  for (const s of samples) {
    if (!Number.isFinite(s.value) || s.value < 0) continue; // мусор отбрасываем

    // Сон привязываем к дате пробуждения, остальное — к началу замера
    const anchor = s.metric === 'sleep' ? s.end : s.start;
    const date = userDateOf(anchor, timeZone);

    if (!byDate.has(date)) byDate.set(date, new Map());
    const metrics = byDate.get(date)!;
    if (!metrics.has(s.metric)) metrics.set(s.metric, { samples: [] });
    metrics.get(s.metric)!.samples.push(s);
  }

  const out: DailyHealth[] = [];

  for (const [date, metrics] of [...byDate.entries()].sort()) {
    const day: DailyHealth = { date, sources: [] };
    const seenSources = new Set<string>();

    for (const [metric, bucket] of metrics) {
      // Группируем по источнику
      const bySource = new Map<string, HealthSample[]>();
      for (const s of bucket.samples) {
        if (!bySource.has(s.source)) bySource.set(s.source, []);
        bySource.get(s.source)!.push(s);
      }

      // Сворачиваем каждый источник отдельно
      const perSource = [...bySource.entries()].map(([source, list]) => ({
        source,
        trust: list[0].confidence ?? trustOf(source),
        value: reduceSamples(list, AGGREGATION[metric]),
      }));

      // Самый доверенный выигрывает; при равенстве — больший объём данных
      perSource.sort((a, b) => b.trust - a.trust || b.value - a.value);
      const winner = perSource[0];
      if (!winner) continue;

      seenSources.add(winner.source);
      assignMetric(day, metric, winner.value);
    }

    day.sources = [...seenSources].sort();
    out.push(day);
  }

  return out;
}

function reduceSamples(list: HealthSample[], mode: 'sum' | 'last' | 'max' | 'avg'): number {
  switch (mode) {
    case 'sum': return list.reduce((a, s) => a + s.value, 0);
    case 'max': return Math.max(...list.map(s => s.value));
    case 'avg': return list.reduce((a, s) => a + s.value, 0) / list.length;
    case 'last': {
      const sorted = [...list].sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
      return sorted[sorted.length - 1].value;
    }
  }
}

function assignMetric(day: DailyHealth, metric: HealthMetric, value: number): void {
  switch (metric) {
    case 'weight': day.weightKg = round(value, 2); break;
    case 'steps': day.steps = Math.round(value); break;
    case 'sleep': day.sleepHours = round(value, 2); break;
    case 'calories': day.activeCalories = Math.round(value); break;
    case 'heartRate': day.restingHeartRate = Math.round(value); break;
  }
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

// ═══════════════════════════════════════════════════════════
//  ПРАВДОПОДОБНОСТЬ ДАННЫХ
// ═══════════════════════════════════════════════════════════

export interface Anomaly {
  date: string;
  metric: HealthMetric;
  value: number;
  reason: string;
}

/** Физически возможные границы — всё за ними почти наверняка сбой датчика */
const PLAUSIBLE: Partial<Record<HealthMetric, [number, number]>> = {
  weight: [25, 400],
  steps: [0, 120_000],
  sleep: [0, 20],
  calories: [0, 10_000],
  heartRate: [25, 220],
};

/**
 * Отлавливает заведомо ложные значения до того, как они испортят
 * график и сломают эпический квест «минус 24 кг».
 *
 * Два вида проверки: абсолютные границы и резкие скачки. Вес,
 * прыгнувший на 5 кг за сутки, — это кто-то другой встал на весы.
 */
export function findAnomalies(days: DailyHealth[]): Anomaly[] {
  const out: Anomaly[] = [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));

  const read = (d: DailyHealth, m: HealthMetric): number | undefined => ({
    weight: d.weightKg, steps: d.steps, sleep: d.sleepHours,
    calories: d.activeCalories, heartRate: d.restingHeartRate,
  }[m]);

  for (const day of sorted) {
    for (const [metric, [lo, hi]] of Object.entries(PLAUSIBLE) as [HealthMetric, [number, number]][]) {
      const v = read(day, metric);
      if (v === undefined) continue;
      if (v < lo || v > hi) {
        out.push({ date: day.date, metric, value: v, reason: `вне диапазона ${lo}–${hi}` });
      }
    }
  }

  // Скачок веса между соседними замерами
  const weights = sorted.filter(d => d.weightKg !== undefined);
  for (let i = 1; i < weights.length; i++) {
    const prev = weights[i - 1], cur = weights[i];
    const gapDays = Math.max(1,
      Math.round((Date.parse(cur.date) - Date.parse(prev.date)) / 86_400_000));
    const delta = Math.abs(cur.weightKg! - prev.weightKg!);
    // 2 кг в сутки — предел физиологии, дальше это вода или чужой человек
    if (delta / gapDays > 2) {
      out.push({
        date: cur.date, metric: 'weight', value: cur.weightKg!,
        reason: `скачок ${delta.toFixed(1)} кг за ${gapDays} дн.`,
      });
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
//  СЛИЯНИЕ С РУЧНЫМ ВВОДОМ
// ═══════════════════════════════════════════════════════════

/**
 * Импорт не должен затирать то, что человек вписал руками.
 *
 * Правило простое: ручной ввод всегда главнее. Если пользователь
 * исправил вес на 94.8, а весы в следующей синхронизации снова
 * прислали 95.0 — остаётся 94.8.
 */
export function mergeWithManual(
  imported: DailyHealth,
  manual: Partial<DailyHealth> | undefined
): DailyHealth {
  if (!manual) return imported;

  const merged: DailyHealth = { ...imported };
  for (const key of ['weightKg', 'steps', 'sleepHours', 'activeCalories', 'restingHeartRate'] as const) {
    const m = manual[key];
    if (m !== undefined && m !== null) (merged[key] as number) = m;
  }
  if (manual.weightKg !== undefined || manual.steps !== undefined) {
    merged.sources = [...new Set([...merged.sources, 'manual'])].sort();
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════
//  ОРКЕСТРАТОР ИМПОРТА
// ═══════════════════════════════════════════════════════════

export interface ImportResult {
  days: DailyHealth[];
  anomalies: Anomaly[];
  skippedMetrics: HealthMetric[];
  provider: string;
}

/**
 * Полный цикл: спросить разрешения, выгрузить, свернуть, проверить.
 *
 * Метрики, на которые не дали доступ, не роняют импорт — просто
 * попадают в skippedMetrics, и приложение покажет, чего не хватает.
 */
export async function importHealth(
  provider: HealthProvider,
  metrics: HealthMetric[],
  fromISO: string,
  toISO: string,
  timeZone: string
): Promise<ImportResult> {
  if (!(await provider.isAvailable())) {
    throw new Error(`Источник «${provider.name}» недоступен на этом устройстве`);
  }

  const granted = await provider.requestPermissions(metrics);
  const skipped = metrics.filter(m => !granted.includes(m));

  const all: HealthSample[] = [];
  for (const metric of granted) {
    try {
      all.push(...(await provider.query(metric, fromISO, toISO)));
    } catch {
      // Одна отвалившаяся метрика не должна ронять весь импорт
      skipped.push(metric);
    }
  }

  const days = aggregateToDays(all, timeZone);
  return {
    days,
    anomalies: findAnomalies(days),
    skippedMetrics: [...new Set(skipped)],
    provider: provider.name,
  };
}

// ═══════════════════════════════════════════════════════════
//  ЗАГЛУШКА ДЛЯ РАЗРАБОТКИ И ТЕСТОВ
// ═══════════════════════════════════════════════════════════

export class MockHealthProvider implements HealthProvider {
  readonly name = 'mock';
  constructor(
    private samples: HealthSample[] = [],
    private opts: { available?: boolean; deny?: HealthMetric[]; fail?: HealthMetric[] } = {}
  ) {}

  async isAvailable() { return this.opts.available ?? true; }

  async requestPermissions(metrics: HealthMetric[]) {
    return metrics.filter(m => !(this.opts.deny ?? []).includes(m));
  }

  async query(metric: HealthMetric, fromISO: string, toISO: string) {
    if ((this.opts.fail ?? []).includes(metric)) throw new Error('сбой источника');
    const from = Date.parse(fromISO), to = Date.parse(toISO);
    return this.samples.filter(s =>
      s.metric === metric && Date.parse(s.start) >= from && Date.parse(s.start) <= to);
  }
}
