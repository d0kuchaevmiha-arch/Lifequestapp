import { describe, it, expect, vi } from 'vitest';
import {
  dayToMarkdown, yamlString, safeFileName, pathForDay,
  buildDashboardNote, exportDays, parseFrontmatter,
  type DayExport, type VaultWriter,
} from '../lib/integrations/obsidian';

const day: DayExport = {
  date: '2026-05-15',
  level: 11, totalXP: 4040, xpEarned: 170, coins: 16, streak: 12,
  quests: [
    { title: 'Взвеситься', done: true, xp: 5, sphere: 'Энергия' },
    { title: 'Тренировка', done: false, xp: 25, sphere: 'Энергия' },
  ],
  spheres: [{ name: 'Дело', level: 9, xp: 745 }],
  activities: [{ name: 'Кодинг', minutes: 95 }],
  health: { weightKg: 95, steps: 4200, sleepHours: 5.7, calories: 386, caloriesTarget: 2000 },
  notes: 'Хороший день.',
};

describe('Экранирование YAML', () => {
  it('строка с двоеточием закавычивается', () => {
    // Иначе frontmatter ломается целиком и Dataview теряет заметку
    expect(yamlString('Купить молоко: 2 литра')).toBe('"Купить молоко: 2 литра"');
  });

  it('слова-ловушки YAML закавычиваются', () => {
    for (const v of ['yes', 'no', 'true', 'null', 'on']) {
      expect(yamlString(v), v).toMatch(/^".*"$/);
    }
  });

  it('кавычки внутри экранируются', () => {
    expect(yamlString('Он сказал "привет"')).toBe('"Он сказал \\"привет\\""');
  });

  it('простое слово остаётся без кавычек', () => {
    expect(yamlString('тренировка')).toBe('тренировка');
  });

  it('строка, начинающаяся с цифры, закавычивается', () => {
    expect(yamlString('10 километров')).toMatch(/^".*"$/);
  });
});

describe('Имена файлов', () => {
  it('запрещённые символы заменяются', () => {
    expect(safeFileName('отчёт: 15/05 "итог"')).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('путь собирается с папкой', () => {
    expect(pathForDay(day, { folder: 'LifeQuest/Дневник' }))
      .toBe('LifeQuest/Дневник/2026-05-15.md');
  });

  it('лишние слэши в папке убираются', () => {
    expect(pathForDay(day, { folder: '/LifeQuest/' })).toBe('LifeQuest/2026-05-15.md');
  });

  it('без папки файл кладётся в корень', () => {
    expect(pathForDay(day)).toBe('2026-05-15.md');
  });
});

describe('Сериализация дня', () => {
  const md = dayToMarkdown(day);

  it('frontmatter содержит числа для Dataview', () => {
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('level: 11');
    expect(md).toContain('weight_kg: 95');
    expect(md).toContain('steps: 4200');
  });

  it('счётчик квестов считается, а не берётся наугад', () => {
    expect(md).toContain('quests_done: 1');
    expect(md).toContain('quests_total: 2');
  });

  it('квесты становятся чекбоксами Obsidian', () => {
    // Их можно отмечать прямо в заметке
    expect(md).toContain('- [x] Взвеситься');
    expect(md).toContain('- [ ] Тренировка');
  });

  it('минуты переводятся в часы', () => {
    expect(md).toContain('1 ч 35 мин');
  });

  it('ровный час без остатка пишется коротко', () => {
    const m = dayToMarkdown({ ...day, activities: [{ name: 'Сон', minutes: 480 }] });
    expect(m).toContain('8 ч');
    expect(m).not.toContain('8 ч 0 мин');
  });

  it('заметка пользователя попадает в текст', () => {
    expect(md).toContain('Хороший день.');
  });

  it('отсутствующие блоки не выводятся пустыми', () => {
    const minimal = dayToMarkdown({
      date: '2026-05-15', level: 1, totalXP: 0, xpEarned: 0, coins: 0, streak: 0, quests: [],
    });
    expect(minimal).not.toContain('## Здоровье');
    expect(minimal).not.toContain('## Заметки');
    expect(minimal).not.toContain('## Квесты');
  });

  it('ссылки на соседние дни считаются верно', () => {
    const m = dayToMarkdown(day, { linkAdjacentDays: true });
    expect(m).toContain('[[2026-05-14|← Вчера]]');
    expect(m).toContain('[[2026-05-16|Завтра →]]');
  });

  it('переход через границу месяца не ломается', () => {
    const m = dayToMarkdown({ ...day, date: '2026-05-31' }, { linkAdjacentDays: true });
    expect(m).toContain('[[2026-06-01|Завтра →]]');
  });

  it('спецсимволы в названии квеста не ломают разметку', () => {
    const m = dayToMarkdown({
      ...day,
      quests: [{ title: 'Прочитать *Война и мир* [том 1]', done: false, xp: 10 }],
    });
    expect(m).toContain('\\*Война и мир\\*');
    expect(m).toContain('\\[том 1\\]');
  });

  it('вертикальная черта в названии сферы не ломает таблицу', () => {
    const m = dayToMarkdown({ ...day, spheres: [{ name: 'Дело | Работа', level: 1, xp: 10 }] });
    const row = m.split('\n').find(l => l.includes('Дело'))!;
    // Ровно три разделителя столбцов, четвёртый экранирован
    expect(row.match(/(?<!\\)\|/g)!.length).toBe(4);
  });
});

describe('Сводная заметка', () => {
  const note = buildDashboardNote({ folder: 'LifeQuest' });

  it('содержит запросы Dataview', () => {
    expect(note).toContain('```dataview');
    expect(note).toContain('FROM "LifeQuest"');
  });

  it('без папки опирается на тег', () => {
    expect(buildDashboardNote()).toContain('FROM #lifequest');
  });

  it('все блоки кода закрыты', () => {
    expect((note.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe('Пакетный экспорт', () => {
  const makeWriter = (failOn?: string): VaultWriter & { files: Map<string, string> } => {
    const files = new Map<string, string>();
    return {
      files,
      writeFile: vi.fn(async (path: string, content: string) => {
        if (path === failOn) throw new Error('файл заблокирован');
        files.set(path, content);
      }),
    };
  };

  it('все дни записываются вместе со сводкой', async () => {
    const w = makeWriter();
    const r = await exportDays([day, { ...day, date: '2026-05-16' }], w, { folder: 'LQ' });

    expect(r.written).toHaveLength(2);
    expect(r.failed).toHaveLength(0);
    expect(r.dashboardPath).toBe('LQ/LifeQuest.md');
    expect(w.files.size).toBe(3);
  });

  it('один упавший файл не отменяет остальные', async () => {
    // Иначе один заблокированный файл сорвал бы экспорт за весь год
    const w = makeWriter('LQ/2026-05-15.md');
    const r = await exportDays([day, { ...day, date: '2026-05-16' }], w, { folder: 'LQ' });

    expect(r.written).toEqual(['LQ/2026-05-16.md']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toBe('файл заблокирован');
  });

  it('сводку можно не создавать', async () => {
    const w = makeWriter();
    const r = await exportDays([day], w, {}, false);
    expect(r.dashboardPath).toBeNull();
    expect(w.files.size).toBe(1);
  });

  it('пустой список не создаёт дневных файлов', async () => {
    const w = makeWriter();
    const r = await exportDays([], w, {}, false);
    expect(r.written).toHaveLength(0);
  });
});

describe('Чтение обратно', () => {
  it('frontmatter разбирается с типами', () => {
    const fm = parseFrontmatter(dayToMarkdown(day))!;
    expect(fm.level).toBe(11);
    expect(fm.weight_kg).toBe(95);
    expect(fm.date).toBe('2026-05-15');
  });

  it('круговой проход сохраняет значения', () => {
    // Записали и прочитали — числа не поехали
    const fm = parseFrontmatter(dayToMarkdown(day))!;
    expect(fm.total_xp).toBe(day.totalXP);
    expect(fm.streak).toBe(day.streak);
  });

  it('заметка без frontmatter даёт null, а не падение', () => {
    expect(parseFrontmatter('# Просто заголовок')).toBeNull();
  });

  it('кавычки снимаются при чтении', () => {
    const fm = parseFrontmatter('---\ntitle: "Отчёт: май"\n---\n')!;
    expect(fm.title).toBe('Отчёт: май');
  });

  it('переводы строк Windows не мешают разбору', () => {
    const fm = parseFrontmatter('---\r\nlevel: 5\r\n---\r\n')!;
    expect(fm.level).toBe(5);
  });
});
