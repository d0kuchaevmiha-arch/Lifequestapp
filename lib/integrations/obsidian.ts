/**
 * LifeQuest — экспорт в Obsidian
 *
 * Пользователь пришёл из Obsidian, и главный страх при переезде —
 * «а вдруг я потеряю данные и останусь ни с чем». Двусторонняя
 * совместимость снимает этот страх: заметки продолжают лежать
 * в его хранилище обычными markdown-файлами.
 *
 * Формат рассчитан на Dataview — популярный плагин, который умеет
 * собирать таблицы из frontmatter всех заметок. Благодаря этому
 * пользователь может строить свои запросы поверх наших данных.
 */

// ═══════════════════════════════════════════════════════════
//  ТИПЫ
// ═══════════════════════════════════════════════════════════

export interface DayExport {
  date: string;                   // YYYY-MM-DD
  level: number;
  totalXP: number;
  xpEarned: number;
  coins: number;
  streak: number;
  quests: Array<{ title: string; done: boolean; xp: number; sphere?: string }>;
  spheres?: Array<{ name: string; level: number; xp: number }>;
  activities?: Array<{ name: string; minutes: number }>;
  health?: {
    weightKg?: number; steps?: number; sleepHours?: number;
    calories?: number; caloriesTarget?: number;
  };
  notes?: string;
}

export interface ExportOptions {
  /** Папка внутри хранилища, например 'LifeQuest/Дневник' */
  folder?: string;
  /** Добавлять ссылки [[2026-05-14]] на соседние дни */
  linkAdjacentDays?: boolean;
  /** Теги в frontmatter */
  tags?: string[];
}

// ═══════════════════════════════════════════════════════════
//  ЭКРАНИРОВАНИЕ YAML
// ═══════════════════════════════════════════════════════════

/**
 * Obsidian разбирает frontmatter как YAML, и незакавыченная строка
 * с двоеточием ломает весь блок. Заметка «Купить молоко: 2 литра»
 * без обработки превратит frontmatter в мусор и Dataview перестанет
 * видеть заметку целиком.
 */
export function yamlString(v: string): string {
  const needsQuotes = /[:#\-{}\[\],&*?|<>=!%@`"'\n]/.test(v)
    || v.trim() !== v
    || v === ''
    || /^(true|false|null|yes|no|on|off|~)$/i.test(v)
    || /^-?\d/.test(v);

  if (!needsQuotes) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Имя файла без символов, запрещённых в Windows и macOS */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════
//  СЕРИАЛИЗАЦИЯ ДНЯ
// ═══════════════════════════════════════════════════════════

const shiftDate = (date: string, days: number): string => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Превращает день в markdown-заметку.
 *
 * Структура: frontmatter с числами для Dataview, затем человекочитаемый
 * текст. Числа в frontmatter, а не в тексте — иначе Dataview их не увидит
 * и пользователь не сможет построить график веса за год одним запросом.
 */
export function dayToMarkdown(day: DayExport, opts: ExportOptions = {}): string {
  const fm: string[] = ['---'];

  fm.push(`date: ${day.date}`);
  fm.push(`level: ${day.level}`);
  fm.push(`total_xp: ${day.totalXP}`);
  fm.push(`xp_earned: ${day.xpEarned}`);
  fm.push(`coins: ${day.coins}`);
  fm.push(`streak: ${day.streak}`);

  const done = day.quests.filter(q => q.done).length;
  fm.push(`quests_done: ${done}`);
  fm.push(`quests_total: ${day.quests.length}`);

  if (day.health) {
    const h = day.health;
    if (h.weightKg !== undefined) fm.push(`weight_kg: ${h.weightKg}`);
    if (h.steps !== undefined) fm.push(`steps: ${h.steps}`);
    if (h.sleepHours !== undefined) fm.push(`sleep_hours: ${h.sleepHours}`);
    if (h.calories !== undefined) fm.push(`calories: ${h.calories}`);
  }

  const tags = ['lifequest', ...(opts.tags ?? [])];
  fm.push(`tags: [${tags.map(yamlString).join(', ')}]`);
  fm.push('---', '');

  const body: string[] = [`# ${day.date}`, ''];

  if (opts.linkAdjacentDays) {
    body.push(`[[${shiftDate(day.date, -1)}|← Вчера]] · [[${shiftDate(day.date, 1)}|Завтра →]]`, '');
  }

  body.push(`**Уровень ${day.level}** · ${day.xpEarned} XP за день · серия ${day.streak} дн.`, '');

  // Квесты — чекбоксы Obsidian, их можно отмечать прямо в заметке
  if (day.quests.length > 0) {
    body.push('## Квесты', '');
    for (const q of day.quests) {
      const sphere = q.sphere ? ` *(${q.sphere})*` : '';
      body.push(`- [${q.done ? 'x' : ' '}] ${escapeMd(q.title)} — ${q.xp} XP${sphere}`);
    }
    body.push('');
  }

  if (day.spheres?.length) {
    body.push('## Сферы', '', '| Сфера | Уровень | XP |', '|---|---|---|');
    for (const s of day.spheres) {
      body.push(`| ${escapeTableCell(s.name)} | ${s.level} | ${s.xp} |`);
    }
    body.push('');
  }

  if (day.activities?.length) {
    body.push('## Активности', '');
    for (const a of day.activities) {
      body.push(`- ${escapeMd(a.name)} — ${formatMinutes(a.minutes)}`);
    }
    body.push('');
  }

  if (day.health) {
    const h = day.health;
    const rows: string[] = [];
    if (h.weightKg !== undefined) rows.push(`- Вес: ${h.weightKg} кг`);
    if (h.steps !== undefined) rows.push(`- Шаги: ${h.steps.toLocaleString('ru')}`);
    if (h.sleepHours !== undefined) rows.push(`- Сон: ${h.sleepHours} ч`);
    if (h.calories !== undefined) {
      const target = h.caloriesTarget ? ` / ${h.caloriesTarget}` : '';
      rows.push(`- Питание: ${h.calories}${target} ккал`);
    }
    if (rows.length) body.push('## Здоровье', '', ...rows, '');
  }

  if (day.notes?.trim()) {
    body.push('## Заметки', '', day.notes.trim(), '');
  }

  return fm.join('\n') + body.join('\n');
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`;
}

/** Не даём пользовательскому тексту сломать разметку */
function escapeMd(s: string): string {
  return s.replace(/([*_`~\[\]])/g, '\\$1');
}

function escapeTableCell(s: string): string {
  return escapeMd(s).replace(/\|/g, '\\|');
}

// ═══════════════════════════════════════════════════════════
//  ПУТИ ФАЙЛОВ
// ═══════════════════════════════════════════════════════════

export function pathForDay(day: DayExport, opts: ExportOptions = {}): string {
  const folder = opts.folder?.replace(/^\/+|\/+$/g, '');
  const file = `${safeFileName(day.date)}.md`;
  return folder ? `${folder}/${file}` : file;
}

// ═══════════════════════════════════════════════════════════
//  СВОДНАЯ ЗАМЕТКА С ЗАПРОСАМИ DATAVIEW
// ═══════════════════════════════════════════════════════════

/**
 * Одна заметка-панель, которая сама собирает данные из всех дневных.
 *
 * Это и есть смысл экспорта: не просто свалить файлы, а дать
 * пользователю рабочий инструмент в его же хранилище.
 */
export function buildDashboardNote(opts: ExportOptions = {}): string {
  const from = opts.folder ? `"${opts.folder}"` : '#lifequest';

  return [
    '---',
    'tags: [lifequest, dashboard]',
    '---',
    '',
    '# LifeQuest — сводка',
    '',
    '## Последние 30 дней',
    '',
    '```dataview',
    'TABLE level AS "Ур.", xp_earned AS "XP", quests_done + "/" + quests_total AS "Квесты",',
    '      weight_kg AS "Вес", steps AS "Шаги", sleep_hours AS "Сон"',
    `FROM ${from}`,
    'WHERE date',
    'SORT date DESC',
    'LIMIT 30',
    '```',
    '',
    '## Динамика веса',
    '',
    '```dataview',
    'TABLE WITHOUT ID date AS "Дата", weight_kg AS "Вес, кг"',
    `FROM ${from}`,
    'WHERE weight_kg',
    'SORT date ASC',
    '```',
    '',
    '## Итоги месяца',
    '',
    '```dataviewjs',
    `const pages = dv.pages('${from}').where(p => p.date);`,
    'const month = pages.where(p => p.date.toString().startsWith(dv.luxon.DateTime.now().toFormat("yyyy-MM")));',
    'dv.paragraph(`XP за месяц: **${month.array().reduce((a, p) => a + (p.xp_earned ?? 0), 0)}**`);',
    'dv.paragraph(`Дней с записями: **${month.length}**`);',
    '```',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
//  ЗАПИСЬ В ХРАНИЛИЩЕ
// ═══════════════════════════════════════════════════════════

export interface VaultWriter {
  writeFile(path: string, content: string): Promise<void>;
}

export interface ExportSummary {
  written: string[];
  failed: Array<{ path: string; error: string }>;
  dashboardPath: string | null;
}

/**
 * Пакетный экспорт.
 *
 * Отдельный файл, упавший на записи, не отменяет остальные —
 * иначе один заблокированный файл сорвал бы экспорт за весь год.
 */
export async function exportDays(
  days: DayExport[],
  writer: VaultWriter,
  opts: ExportOptions = {},
  includeDashboard = true
): Promise<ExportSummary> {
  const written: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const day of days) {
    const path = pathForDay(day, opts);
    try {
      await writer.writeFile(path, dayToMarkdown(day, opts));
      written.push(path);
    } catch (e) {
      failed.push({ path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  let dashboardPath: string | null = null;
  if (includeDashboard) {
    const folder = opts.folder?.replace(/^\/+|\/+$/g, '');
    const p = folder ? `${folder}/LifeQuest.md` : 'LifeQuest.md';
    try {
      await writer.writeFile(p, buildDashboardNote(opts));
      dashboardPath = p;
    } catch (e) {
      failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { written, failed, dashboardPath };
}

// ═══════════════════════════════════════════════════════════
//  ЧТЕНИЕ ОБРАТНО
// ═══════════════════════════════════════════════════════════

/**
 * Разбор frontmatter — нужен, чтобы понять, какие дни уже выгружены,
 * и не перезаписывать то, что пользователь правил руками в Obsidian.
 */
export function parseFrontmatter(markdown: string): Record<string, string | number> | null {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;

  const out: Record<string, string | number> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === '') continue;

    const asNumber = Number(value);
    out[key] = !Number.isNaN(asNumber) && /^-?[\d.]+$/.test(value)
      ? asNumber
      : value.replace(/^"(.*)"$/s, '$1').replace(/\\"/g, '"');
  }
  return out;
}
