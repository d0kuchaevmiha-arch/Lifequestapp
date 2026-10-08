import { describe, it, expect, vi } from 'vitest';
import {
  isValidBarcode, normalizeBarcode, normalizeOFF, portionOf,
  ProductCache, FoodClient, type Product,
} from '../lib/integrations/food';

const ok = (body: any, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

describe('Проверка штрихкода', () => {
  it('принимает настоящие коды', () => {
    expect(isValidBarcode('4607004891106')).toBe(true); // EAN-13
    expect(isValidBarcode('5449000000996')).toBe(true); // Coca-Cola
    expect(isValidBarcode('96385074')).toBe(true);      // EAN-8
  });

  it('отсекает опечатку в одной цифре', () => {
    // Камера распознала 6 вместо 5 — ловим до сетевого запроса
    expect(isValidBarcode('5449000000995')).toBe(false);
  });

  it('отсекает мусор и неверную длину', () => {
    for (const bad of ['', 'abc', '12345', '123456789012345678']) {
      expect(isValidBarcode(bad), bad).toBe(false);
    }
  });

  it('UPC-A дополняется нулём до EAN-13', () => {
    expect(normalizeBarcode('036000291452')).toBe('0036000291452');
  });

  it('пробелы и дефисы убираются', () => {
    expect(normalizeBarcode('5449-000 000996')).toBe('5449000000996');
  });
});

describe('Нормализация ответа базы', () => {
  const full = {
    product_name: 'Гречка ядрица',
    brands: 'Мистраль, Другой',
    categories: 'Крупы, Гречка',
    image_url: 'https://example.org/img.jpg',
    nutriments: {
      'energy-kcal_100g': 343, proteins_100g: 13.25, fat_100g: 3.4, carbohydrates_100g: 71.5,
    },
  };

  it('полный ответ превращается в продукт', () => {
    const r = normalizeOFF(full, '4607004891106');
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.product.name).toBe('Гречка ядрица');
    expect(r.product.kcal100g).toBe(343);
    expect(r.product.protein100g).toBe(13.25);
  });

  it('берётся только первый бренд из списка', () => {
    const r = normalizeOFF(full, '4607004891106');
    if (r.status !== 'found') throw new Error('ожидался found');
    expect(r.product.brand).toBe('Мистраль');
  });

  it('русское название приоритетнее общего', () => {
    const r = normalizeOFF({ ...full, product_name_ru: 'Гречневая крупа' }, '4607004891106');
    if (r.status !== 'found') throw new Error('ожидался found');
    expect(r.product.name).toBe('Гречневая крупа');
  });

  it('килоджоули переводятся в килокалории', () => {
    // Европейские товары часто указывают только кДж
    const r = normalizeOFF({
      ...full,
      nutriments: { ...full.nutriments, 'energy-kcal_100g': undefined, 'energy-kj_100g': 1435 },
    }, '4607004891106');
    if (r.status !== 'found') throw new Error('ожидался found');
    expect(r.product.kcal100g).toBeCloseTo(343, 0);
  });

  it('числа в виде строк с запятой разбираются', () => {
    // Волонтёры заполняют базу руками, формат гуляет
    const r = normalizeOFF({
      ...full,
      nutriments: { ...full.nutriments, proteins_100g: '13,25', fat_100g: '3.4' },
    }, '4607004891106');
    if (r.status !== 'found') throw new Error('ожидался found');
    expect(r.product.protein100g).toBe(13.25);
    expect(r.product.fat100g).toBe(3.4);
  });

  it('неполные данные помечаются, а не выдаются за готовые', () => {
    const r = normalizeOFF({
      product_name: 'Что-то', nutriments: { 'energy-kcal_100g': 200 },
    }, '4607004891106');
    expect(r.status).toBe('incomplete');
    if (r.status !== 'incomplete') return;
    expect(r.missing).toEqual(['белки', 'жиры', 'углеводы']);
  });

  it('отсутствие названия тоже считается пробелом', () => {
    const r = normalizeOFF({ nutriments: full.nutriments }, '4607004891106');
    if (r.status !== 'incomplete') throw new Error('ожидался incomplete');
    expect(r.missing).toContain('название');
  });

  it('невозможная калорийность отбраковывается', () => {
    // Чистый жир — около 900 ккал на 100 г, выше физически не бывает
    const r = normalizeOFF({
      ...full, nutriments: { ...full.nutriments, 'energy-kcal_100g': 5000 },
    }, '4607004891106');
    expect(r.status).toBe('error');
  });

  it('пустой или битый ответ не роняет разбор', () => {
    expect(normalizeOFF(null, '123').status).toBe('error');
    expect(normalizeOFF('строка', '123').status).toBe('error');
  });

  it('качество данных отражает заполненность', () => {
    const rich = normalizeOFF(full, '1');
    const poor = normalizeOFF({ product_name: 'Х', nutriments: full.nutriments }, '2');
    if (rich.status !== 'found' || poor.status !== 'found') throw new Error('оба должны найтись');
    expect(rich.product.completeness).toBeGreaterThan(poor.product.completeness);
  });
});

describe('Кэш продуктов', () => {
  const p = (barcode: string): Product => ({
    barcode, name: 'Тест', kcal100g: 100, protein100g: 1,
    fat100g: 1, carbs100g: 1, completeness: 0.6,
  });

  it('возвращает ранее сохранённое', () => {
    const c = new ProductCache();
    c.set(p('111'));
    expect(c.get('111')?.name).toBe('Тест');
    expect(c.get('222')).toBeUndefined();
  });

  it('просроченная запись не отдаётся', () => {
    const c = new ProductCache(-1); // всё немедленно протухло
    c.set(p('111'));
    expect(c.get('111')).toBeUndefined();
  });

  it('при переполнении вытесняется самая старая запись', () => {
    const c = new ProductCache(86_400_000, 3);
    ['1', '2', '3'].forEach(b => c.set(p(b)));
    c.get('1');          // освежили первую
    c.set(p('4'));       // вытеснит вторую, а не первую
    expect(c.get('1')).toBeDefined();
    expect(c.get('2')).toBeUndefined();
    expect(c.size).toBe(3);
  });
});

describe('Клиент базы продуктов', () => {
  const body = {
    status: 1,
    product: {
      product_name: 'Кока-кола',
      nutriments: { 'energy-kcal_100g': 42, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 10.6 },
    },
  };

  it('успешный поиск возвращает продукт', async () => {
    const client = new FoodClient({ fetchFn: vi.fn().mockResolvedValue(ok(body)) });
    const r = await client.lookup('5449000000996');
    expect(r.status).toBe('found');
  });

  it('неверный штрихкод не доходит до сети', async () => {
    const fetchFn = vi.fn();
    const client = new FoodClient({ fetchFn });
    const r = await client.lookup('5449000000995');
    expect(r.status).toBe('error');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('повторный поиск берётся из кэша без запроса', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok(body));
    const client = new FoodClient({ fetchFn });
    await client.lookup('5449000000996');
    await client.lookup('5449000000996');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('404 означает «товар не найден», а не ошибку', async () => {
    const client = new FoodClient({ fetchFn: vi.fn().mockResolvedValue(ok({}, 404)) });
    expect((await client.lookup('5449000000996')).status).toBe('not_found');
  });

  it('статус 0 при HTTP 200 тоже означает «не найден»', async () => {
    // Особенность API v2: отсутствие товара приходит с кодом 200
    const client = new FoodClient({ fetchFn: vi.fn().mockResolvedValue(ok({ status: 0 })) });
    expect((await client.lookup('5449000000996')).status).toBe('not_found');
  });

  it('обрыв связи даёт понятное сообщение, а не падение', async () => {
    const client = new FoodClient({ fetchFn: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const r = await client.lookup('5449000000996');
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.message).toMatch(/нет связи/);
  });

  it('зависший запрос обрывается по таймауту', async () => {
    const client = new FoodClient({
      fetchFn: vi.fn(() => new Promise(() => {})) as any,
      timeoutMs: 20,
    });
    const r = await client.lookup('5449000000996');
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.message).toMatch(/не отвечает/);
  });

  it('нечитаемый JSON не роняет приложение', async () => {
    const client = new FoodClient({
      fetchFn: vi.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => { throw new Error('bad json'); },
      } as any),
    });
    expect((await client.lookup('5449000000996')).status).toBe('error');
  });

  it('неполные данные не кэшируются', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({
      status: 1, product: { product_name: 'Х', nutriments: {} },
    }));
    const client = new FoodClient({ fetchFn });
    await client.lookup('5449000000996');
    await client.lookup('5449000000996');
    expect(fetchFn).toHaveBeenCalledTimes(2); // запрос повторился
  });
});

describe('Пересчёт порции', () => {
  const buckwheat: Product = {
    barcode: '4607004891106', name: 'Гречка', brand: 'Мистраль',
    kcal100g: 343, protein100g: 13.25, fat100g: 3.4, carbs100g: 71.5, completeness: 0.85,
  };

  it('150 грамм считаются корректно', () => {
    const e = portionOf(buckwheat, 150);
    expect(e.kcal).toBeCloseTo(514.5, 1);
    expect(e.protein).toBeCloseTo(19.88, 2);
  });

  it('бренд попадает в название записи', () => {
    expect(portionOf(buckwheat, 100).name).toBe('Гречка (Мистраль)');
  });

  it('ровно 100 грамм дают исходные значения', () => {
    const e = portionOf(buckwheat, 100);
    expect(e.kcal).toBe(343);
    expect(e.carbs).toBe(71.5);
  });

  it('нулевая и отрицательная масса отклоняются', () => {
    expect(() => portionOf(buckwheat, 0)).toThrow(/положительным/);
    expect(() => portionOf(buckwheat, -50)).toThrow(/положительным/);
    expect(() => portionOf(buckwheat, NaN)).toThrow();
  });
});
