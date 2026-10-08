/**
 * LifeQuest — поиск продуктов по штрихкоду
 *
 * Open Food Facts — открытая база с более чем тремя миллионами товаров,
 * бесплатная и без ключа. Отсканировал упаковку — получил КБЖУ.
 *
 * Данные там заполняют волонтёры, поэтому половина работы этого модуля —
 * не запрос, а проверка того, что пришло. Поле может отсутствовать,
 * содержать строку вместо числа или единицы на порцию вместо 100 г.
 */

// ═══════════════════════════════════════════════════════════
//  ТИПЫ
// ═══════════════════════════════════════════════════════════

export interface Product {
  barcode: string;
  name: string;
  brand?: string;
  category?: string;
  /** Всё приведено к 100 г — так же, как в базе продуктов приложения */
  kcal100g: number;
  protein100g: number;
  fat100g: number;
  carbs100g: number;
  /** Доля заполненных полей, 0..1 — показываем как «качество данных» */
  completeness: number;
  imageUrl?: string;
}

export type LookupResult =
  | { status: 'found'; product: Product }
  | { status: 'not_found'; barcode: string }
  | { status: 'incomplete'; barcode: string; name?: string; missing: string[] }
  | { status: 'error'; barcode: string; message: string };

// ═══════════════════════════════════════════════════════════
//  ПРОВЕРКА ШТРИХКОДА
// ═══════════════════════════════════════════════════════════

/**
 * Контрольная сумма EAN-13 / EAN-8 / UPC-A.
 *
 * Последняя цифра штрихкода вычисляется из остальных. Проверка на
 * клиенте отсекает опечатки и кривые распознавания камеры до того,
 * как мы потратим сетевой запрос.
 */
export function isValidBarcode(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;

  const digits = code.split('').map(Number);
  const check = digits.pop()!;

  // Веса чередуются 3 и 1, считая справа от контрольной цифры
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** Нормализует код: убирает пробелы и дефисы, дополняет UPC-A до EAN-13 */
export function normalizeBarcode(raw: string): string {
  const clean = raw.replace(/[\s-]/g, '');
  return clean.length === 12 ? '0' + clean : clean;
}

// ═══════════════════════════════════════════════════════════
//  НОРМАЛИЗАЦИЯ ОТВЕТА
// ═══════════════════════════════════════════════════════════

const REQUIRED: Array<[keyof Product, string]> = [
  ['kcal100g', 'калории'],
  ['protein100g', 'белки'],
  ['fat100g', 'жиры'],
  ['carbs100g', 'углеводы'],
];

/** Волонтёры пишут числа как строки, с запятой, с единицами измерения */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const parsed = parseFloat(v.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const KJ_PER_KCAL = 4.184;

/**
 * Превращает сырой ответ Open Food Facts в наш Product.
 *
 * Отдельная функция, чтобы её можно было тестировать на зафиксированных
 * ответах без сети — именно здесь живут все грязные случаи.
 */
export function normalizeOFF(raw: any, barcode: string): LookupResult {
  if (!raw || typeof raw !== 'object') {
    return { status: 'error', barcode, message: 'пустой ответ' };
  }

  const n = raw.nutriments ?? {};
  const name: string | undefined =
    raw.product_name_ru || raw.product_name || raw.generic_name || undefined;

  // Калории: предпочитаем ккал, иначе переводим из килоджоулей
  let kcal = num(n['energy-kcal_100g']);
  if (kcal === undefined) {
    const kj = num(n['energy-kj_100g']) ?? num(n.energy_100g);
    if (kj !== undefined) kcal = kj / KJ_PER_KCAL;
  }

  const draft: Partial<Product> = {
    barcode,
    name,
    brand: typeof raw.brands === 'string' ? raw.brands.split(',')[0].trim() : undefined,
    category: typeof raw.categories === 'string'
      ? raw.categories.split(',').pop()?.trim() : undefined,
    kcal100g: kcal,
    protein100g: num(n.proteins_100g),
    fat100g: num(n.fat_100g),
    carbs100g: num(n.carbohydrates_100g),
    imageUrl: typeof raw.image_url === 'string' ? raw.image_url : undefined,
  };

  const missing = REQUIRED
    .filter(([key]) => draft[key] === undefined || (draft[key] as number) < 0)
    .map(([, label]) => label);

  if (!name) missing.unshift('название');

  if (missing.length > 0) {
    return { status: 'incomplete', barcode, name, missing };
  }

  // Правдоподобность: 100 г не могут давать больше ~900 ккал (чистый жир)
  if (draft.kcal100g! > 950) {
    return { status: 'error', barcode, message: 'калорийность выше физически возможной' };
  }

  const optional = [draft.brand, draft.category, draft.imageUrl];
  const completeness = (4 + optional.filter(Boolean).length) / 7;

  return {
    status: 'found',
    product: {
      ...(draft as Product),
      kcal100g: round(draft.kcal100g!, 1),
      protein100g: round(draft.protein100g!, 2),
      fat100g: round(draft.fat100g!, 2),
      carbs100g: round(draft.carbs100g!, 2),
      completeness: round(completeness, 2),
    },
  };
}

const round = (v: number, d: number) => { const f = 10 ** d; return Math.round(v * f) / f; };

// ═══════════════════════════════════════════════════════════
//  КЭШ
// ═══════════════════════════════════════════════════════════

/**
 * Один и тот же йогурт сканируется каждое утро. Без кэша это
 * ежедневный сетевой запрос ради данных, которые не меняются годами.
 */
export class ProductCache {
  private map = new Map<string, { product: Product; at: number }>();

  constructor(private ttlMs = 30 * 86_400_000, private maxSize = 500) {}

  get(barcode: string): Product | undefined {
    const hit = this.map.get(barcode);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(barcode); return undefined; }
    // Перекладываем в конец — простое LRU поверх порядка вставки Map
    this.map.delete(barcode);
    this.map.set(barcode, hit);
    return hit.product;
  }

  set(product: Product): void {
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(product.barcode, { product, at: Date.now() });
  }

  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

// ═══════════════════════════════════════════════════════════
//  КЛИЕНТ
// ═══════════════════════════════════════════════════════════

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product';

/** Поля запрашиваем явно — ответ целиком весит в разы больше */
const FIELDS = [
  'product_name', 'product_name_ru', 'generic_name', 'brands', 'categories',
  'image_url', 'nutriments',
].join(',');

export interface FoodClientOptions {
  fetchFn?: typeof fetch;
  cache?: ProductCache;
  timeoutMs?: number;
  /** Open Food Facts просит представляться — так они отличают ботов от спама */
  userAgent?: string;
}

export class FoodClient {
  private cache: ProductCache;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private userAgent: string;

  constructor(opts: FoodClientOptions = {}) {
    this.cache = opts.cache ?? new ProductCache();
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.userAgent = opts.userAgent ?? 'LifeQuest/1.0';
  }

  async lookup(rawBarcode: string): Promise<LookupResult> {
    const barcode = normalizeBarcode(rawBarcode);

    if (!isValidBarcode(barcode)) {
      return { status: 'error', barcode, message: 'неверная контрольная сумма штрихкода' };
    }

    const cached = this.cache.get(barcode);
    if (cached) return { status: 'found', product: cached };

    let res: Response;
    try {
      res = await this.withTimeout(
        this.fetchFn(`${OFF_URL}/${barcode}.json?fields=${FIELDS}`, {
          headers: { 'User-Agent': this.userAgent },
        })
      );
    } catch (e) {
      const offline = e instanceof Error && e.message === 'timeout';
      return {
        status: 'error', barcode,
        message: offline ? 'база продуктов не отвечает' : 'нет связи с базой продуктов',
      };
    }

    if (res.status === 404) return { status: 'not_found', barcode };
    if (!res.ok) return { status: 'error', barcode, message: `база ответила ${res.status}` };

    let body: any;
    try { body = await res.json(); }
    catch { return { status: 'error', barcode, message: 'нечитаемый ответ базы' }; }

    // В API v2 статус 0 означает «товар не найден» при HTTP 200
    if (body?.status === 0 || !body?.product) return { status: 'not_found', barcode };

    const result = normalizeOFF(body.product, barcode);
    if (result.status === 'found') this.cache.set(result.product);
    return result;
  }

  private withTimeout(p: Promise<Response>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
      p.then(r => { clearTimeout(t); resolve(r); },
             e => { clearTimeout(t); reject(e); });
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  ПОРЦИИ
// ═══════════════════════════════════════════════════════════

export interface NutritionEntry {
  name: string;
  grams: number;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** Пересчёт продукта на съеденную массу */
export function portionOf(product: Product, grams: number): NutritionEntry {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new Error('Масса порции должна быть положительным числом');
  }
  const k = grams / 100;
  return {
    name: product.brand ? `${product.name} (${product.brand})` : product.name,
    grams: round(grams, 1),
    kcal: round(product.kcal100g * k, 1),
    protein: round(product.protein100g * k, 2),
    fat: round(product.fat100g * k, 2),
    carbs: round(product.carbs100g * k, 2),
  };
}
