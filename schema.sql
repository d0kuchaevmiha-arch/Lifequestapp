-- ═══════════════════════════════════════════════════════════
--  LifeQuest — схема БД (Supabase / PostgreSQL)
--
--  Ключевые решения:
--   • Вся логика XP живёт в триггерах, а не в React. Клиент не может
--     начислить себе опыт в обход правил.
--   • daily_stats денормализована: экран «Итоги» читает готовые суммы,
--     а не агрегирует тысячи строк при каждом открытии.
--   • Сферы — данные, а не хардкод. Пользователь может их менять.
-- ═══════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────
--  ПОЛЬЗОВАТЕЛЬ
-- ─────────────────────────────────────────────

create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  username      text not null,
  avatar_url    text,
  title         text default 'Новичок',
  total_xp      integer not null default 0 check (total_xp >= 0),
  level         integer not null default 0,
  coins         integer not null default 0 check (coins >= 0),
  focus_sphere  uuid,                       -- сфера недели, даёт +20% XP
  timezone      text not null default 'Asia/Almaty',
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────
--  СФЕРЫ (настраиваемые — улучшение №10 из списка добавлений)
-- ─────────────────────────────────────────────

create table spheres (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles on delete cascade,
  name        text not null,
  icon        text not null default '⭐',
  color       text not null default '#a855f7',
  sort_order  integer not null default 0,
  total_xp    integer not null default 0 check (total_xp >= 0),
  level       integer not null default 0,
  is_archived boolean not null default false
);

create index spheres_user_idx on spheres (user_id) where not is_archived;

-- Ёмкость уровня сферы: единая формула вместо разнобоя 60/120
create or replace function sphere_capacity(p_level integer)
returns integer language sql immutable as $$
  select 60 + 20 * greatest(p_level, 0);
$$;

-- Пересчёт уровня сферы из накопленного XP
create or replace function sphere_level_from_xp(p_xp integer)
returns integer language plpgsql immutable as $$
declare
  v_level integer := 0;
  v_rest  integer := greatest(p_xp, 0);
begin
  while v_rest >= sphere_capacity(v_level) loop
    v_rest  := v_rest - sphere_capacity(v_level);
    v_level := v_level + 1;
    exit when v_level > 999;
  end loop;
  return v_level;
end;
$$;

-- ─────────────────────────────────────────────
--  УРОВНИ ПЕРСОНАЖА
-- ─────────────────────────────────────────────

-- Зеркало lib/gamification.ts: level = floor((xp/100)^0.65)
create or replace function level_from_xp(p_xp integer)
returns integer language sql immutable as $$
  select floor(power(greatest(p_xp, 0)::numeric / 100, 0.65))::integer;
$$;

-- ceil, а не round: при округлении вниз показанный порог оказывается
-- ниже настоящей границы, и уровень не повышается ровно на нём
create or replace function xp_for_level(p_level integer)
returns integer language sql immutable as $$
  select case when p_level <= 0 then 0
              else ceil(100 * power(p_level::numeric, 1 / 0.65))::integer
         end;
$$;

-- ─────────────────────────────────────────────
--  ДЕНОРМАЛИЗОВАННАЯ ДНЕВНАЯ СТАТИСТИКА
--  (улучшение №9 — без неё «Итоги» за год = агрегация тысяч строк)
-- ─────────────────────────────────────────────

create table daily_stats (
  user_id         uuid not null references profiles on delete cascade,
  date            date not null,

  -- raw_xp ОБЯЗАТЕЛЕН отдельно от xp_earned: soft cap считается
  -- от сырого XP, иначе потолок обходится повторными начислениями
  raw_xp          integer not null default 0,
  xp_earned       integer not null default 0,

  quests_done     integer not null default 0,
  quests_total    integer not null default 0,
  activity_minutes integer not null default 0,

  weight_kg       numeric(5,2),
  steps           integer,
  calories        integer,
  sleep_hours     numeric(4,2),
  pages_read      integer,
  income          numeric(12,2),

  is_perfect_day  boolean not null default false,
  primary key (user_id, date)
);

create index daily_stats_range_idx on daily_stats (user_id, date desc);

-- ─────────────────────────────────────────────
--  КВЕСТЫ
-- ─────────────────────────────────────────────

create type quest_type as enum ('daily', 'weekly', 'epic', 'side');

create table quests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles on delete cascade,
  sphere_id    uuid references spheres on delete set null,
  title        text not null,
  icon         text default '🎯',
  type         quest_type not null default 'daily',
  base_xp      integer not null default 10 check (base_xp between 0 and 500),
  coin_reward  integer not null default 0,
  -- для эпических квестов
  target_value numeric,
  current_value numeric default 0,
  unit         text,
  deadline     date,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index quests_user_active_idx on quests (user_id, type) where is_active;

create table quest_completions (
  id           uuid primary key default gen_random_uuid(),
  quest_id     uuid not null references quests on delete cascade,
  user_id      uuid not null references profiles on delete cascade,
  date         date not null,
  completed_at timestamptz not null default now(),
  base_xp      integer not null,
  bonus_multiplier numeric(4,2) not null default 1,
  raw_xp       integer not null,   -- после бонусов, до потолка
  xp_awarded   integer not null,   -- после потолка — то, что реально начислено
  unique (quest_id, date)          -- защита от двойного начисления
);

-- ─────────────────────────────────────────────
--  СТРИКИ (заморозки + щадящее падение — улучшение №4)
-- ─────────────────────────────────────────────

create table streaks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles on delete cascade,
  quest_id       uuid references quests on delete cascade,
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  freezes_left   integer not null default 2,
  last_date      date,
  unique (user_id, quest_id)
);

create or replace function update_streak(p_user uuid, p_quest uuid, p_date date)
returns integer language plpgsql as $$
declare
  s streaks%rowtype;
  v_gap integer;
  v_skipped integer;
  v_new integer;
begin
  select * into s from streaks where user_id = p_user and quest_id = p_quest;

  if not found then
    insert into streaks (user_id, quest_id, current_streak, longest_streak, last_date)
    values (p_user, p_quest, 1, 1, p_date);
    return 1;
  end if;

  -- Строка стрика может существовать с пустой датой (создана кроном
  -- или после сброса) — вычитание NULL дало бы NULL и обрушило логику
  if s.last_date is null then
    update streaks
       set current_streak = 1,
           longest_streak = greatest(longest_streak, 1),
           last_date = p_date
     where id = s.id;
    return 1;
  end if;

  v_gap := p_date - s.last_date;

  if v_gap = 0 then
    return s.current_streak;                      -- уже отмечено сегодня
  elsif v_gap = 1 then
    v_new := s.current_streak + 1;                -- честное продолжение
  else
    v_skipped := v_gap - 1;
    if s.freezes_left >= v_skipped then
      v_new := s.current_streak + 1;              -- пропуск закрыт заморозкой
      update streaks set freezes_left = freezes_left - v_skipped
        where id = s.id;
    elsif s.current_streak >= 7 then
      v_new := greatest(1, s.current_streak - 3 * v_skipped);  -- щадящее падение
    else
      v_new := 1;                                 -- короткая серия — сброс
    end if;
  end if;

  update streaks
     set current_streak = v_new,
         longest_streak = greatest(longest_streak, v_new),
         last_date = p_date
   where id = s.id;

  return v_new;
end;
$$;

-- ─────────────────────────────────────────────
--  РАСЧЁТ БОНУСОВ И ПОТОЛКА (зеркало gamification.ts)
-- ─────────────────────────────────────────────

-- Аддитивные надбавки с потолком ×2.5 (улучшение №2)
create or replace function calc_bonus(
  p_streak integer,
  p_is_focus boolean,
  p_morning boolean,
  p_perfect boolean
) returns numeric language sql immutable as $$
  select 1 + least(1.5,
      case when p_streak >= 100 then 0.75
           when p_streak >= 30  then 0.50
           when p_streak >= 14  then 0.30
           when p_streak >= 7   then 0.15
           else 0 end
    + case when p_is_focus then 0.20 else 0 end
    + case when p_morning  then 0.10 else 0 end
    + case when p_perfect  then 0.25 else 0 end
  );
$$;

-- Накопительная функция: сколько всего начислено за p_total сырого XP.
-- Ярусы: 0..300 по ставке 1.0, 300..500 по 0.5, дальше по 0.25
create or replace function cumulative_granted(p_total numeric)
returns numeric language sql immutable as $$
  select greatest(least(p_total, 300), 0) * 1.0
       + greatest(least(p_total, 500) - 300, 0) * 0.5
       + greatest(p_total - 500, 0) * 0.25;
$$;

-- Прогрессивный потолок как РАЗНОСТЬ двух накопительных значений.
--
-- Независимый расчёт каждой порции накапливал ошибку округления:
-- двадцать действий по 50 XP давали 530, а одно на 1000 — 525.
-- Разность телескопируется, поэтому дробление активности
-- на мелкие записи больше не даёт преимущества.
create or replace function apply_soft_cap(p_raw_today integer, p_raw integer)
returns integer language sql immutable as $$
  select round(cumulative_granted(greatest(p_raw_today, 0) + p_raw))::integer
       - round(cumulative_granted(greatest(p_raw_today, 0)))::integer;
$$;

-- ─────────────────────────────────────────────
--  ГЛАВНЫЙ ТРИГГЕР: начисление XP при выполнении квеста
--
--  Одно действие клиента (insert в quest_completions) обновляет:
--  бонусы → потолок → профиль → сферу → уровень → daily_stats → ачивки
-- ─────────────────────────────────────────────

create or replace function on_quest_completed()
returns trigger language plpgsql security definer as $$
declare
  v_quest      quests%rowtype;
  v_profile    profiles%rowtype;
  v_streak     integer;
  v_raw_today  integer;
  v_multiplier numeric;
  v_raw        integer;
  v_granted    integer;
  v_morning    boolean;
  v_is_focus   boolean;
  v_done       integer;
  v_total      integer;
  v_perfect    boolean;
  v_old_level  integer;
  v_new_level  integer;
begin
  select * into v_quest   from quests   where id = new.quest_id;
  select * into v_profile from profiles where id = new.user_id;

  -- Контекст бонусов
  v_streak   := update_streak(new.user_id, new.quest_id, new.date);
  v_is_focus := v_quest.sphere_id is not null
                and v_quest.sphere_id = v_profile.focus_sphere;
  v_morning  := extract(hour from (new.completed_at at time zone v_profile.timezone)) < 10;

  -- Идеальный день: все активные дневные квесты закрыты.
  -- Триггер BEFORE INSERT — текущей строки в таблице ещё нет,
  -- поэтому считаем её вручную через +1, иначе бонус не сработает никогда
  select count(*) into v_total
    from quests where user_id = new.user_id and type = 'daily' and is_active;
  select count(*) into v_done
    from quest_completions qc
    join quests q on q.id = qc.quest_id
   where qc.user_id = new.user_id and qc.date = new.date and q.type = 'daily';

  v_perfect := v_total > 0
               and v_quest.type = 'daily'
               and (v_done + 1) >= v_total;

  -- Сырой XP за сегодня — база для потолка
  select coalesce(raw_xp, 0) into v_raw_today
    from daily_stats where user_id = new.user_id and date = new.date;
  v_raw_today := coalesce(v_raw_today, 0);

  v_multiplier := calc_bonus(v_streak, v_is_focus, v_morning, v_perfect);
  v_raw        := round(v_quest.base_xp * v_multiplier)::integer;
  v_granted    := apply_soft_cap(v_raw_today, v_raw);

  -- Записываем расчёт в саму строку выполнения (аудит + отладка баланса)
  new.base_xp          := v_quest.base_xp;
  new.bonus_multiplier := v_multiplier;
  new.raw_xp           := v_raw;
  new.xp_awarded       := v_granted;

  -- Профиль
  v_old_level := v_profile.level;
  v_new_level := level_from_xp(v_profile.total_xp + v_granted);

  update profiles
     set total_xp = total_xp + v_granted,
         level    = v_new_level,
         coins    = coins + v_quest.coin_reward
                    + case when v_new_level > v_old_level
                           then (v_new_level - v_old_level) * 5   -- бонус за левелап
                           else 0 end
   where id = new.user_id;

  -- Сфера
  if v_quest.sphere_id is not null then
    update spheres
       set total_xp = total_xp + v_granted,
           level    = sphere_level_from_xp(total_xp + v_granted)
     where id = v_quest.sphere_id;
  end if;

  -- Денормализованная дневная статистика
  insert into daily_stats (user_id, date, raw_xp, xp_earned, quests_done, quests_total, is_perfect_day)
  values (new.user_id, new.date, v_raw, v_granted, 1, v_total, v_perfect)
  on conflict (user_id, date) do update
     set raw_xp         = daily_stats.raw_xp + v_raw,
         xp_earned      = daily_stats.xp_earned + v_granted,
         quests_done    = daily_stats.quests_done + 1,
         quests_total   = v_total,
         is_perfect_day = v_perfect;

  return new;
end;
$$;

create trigger trg_quest_completed
  before insert on quest_completions
  for each row execute function on_quest_completed();

-- ─────────────────────────────────────────────
--  АКТИВНОСТИ (навыки с таймером)
-- ─────────────────────────────────────────────

create table activities (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles on delete cascade,
  sphere_id   uuid references spheres on delete set null,
  name        text not null,
  icon        text default '⏱️',
  color       text default '#a855f7',
  cover_url   text,
  total_xp    integer not null default 0,
  level       integer not null default 0,
  total_minutes integer not null default 0,
  xp_per_hour integer not null default 20,
  is_hidden   boolean not null default false
);

create table activity_logs (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities on delete cascade,
  user_id     uuid not null references profiles on delete cascade,
  date        date not null,
  minutes     integer not null check (minutes > 0),
  raw_xp      integer not null default 0,
  xp_awarded  integer not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);

create index activity_logs_window_idx on activity_logs (user_id, date desc);

-- Для окна «последние 30 дней» вместо счётчика X/365 (улучшение №5)
create or replace view activity_recent_window as
select
  a.id as activity_id,
  a.user_id,
  count(distinct l.date) filter (where l.date > current_date - 30) as days_last_30,
  sum(l.minutes)         filter (where l.date > current_date - 30) as minutes_last_30,
  max(l.date) as last_active
from activities a
left join activity_logs l on l.activity_id = a.id
group by a.id, a.user_id;

-- ─────────────────────────────────────────────
--  ЗДОРОВЬЕ, ПИТАНИЕ, НАГРАДЫ
-- ─────────────────────────────────────────────

create table health_settings (
  user_id             uuid primary key references profiles on delete cascade,
  start_weight        numeric(5,2),
  goal_weight         numeric(5,2),
  deficit_min         integer default 1800,
  deficit_max         integer default 1900,
  norm_min            integer default 1901,
  norm_max            integer default 2200,
  daily_steps_goal    integer default 10000,
  daily_sleep_goal    numeric(3,1) default 8.0
);

create table products (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles on delete cascade,  -- null = глобальный
  name       text not null,
  category   text,
  barcode    text,
  kcal_100g  numeric(6,2) not null,
  protein_100g numeric(5,2) not null default 0,
  fat_100g   numeric(5,2) not null default 0,
  carbs_100g numeric(5,2) not null default 0
);

create index products_search_idx on products using gin (to_tsvector('russian', name));
create index products_barcode_idx on products (barcode) where barcode is not null;

create table nutrition_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  product_id uuid references products on delete set null,
  date       date not null,
  name       text not null,
  grams      numeric(7,2) not null,
  kcal       numeric(7,2) not null,
  protein    numeric(6,2) not null default 0,
  fat        numeric(6,2) not null default 0,
  carbs      numeric(6,2) not null default 0
);

-- Питание сразу попадает в дневную сводку
create or replace function on_nutrition_change()
returns trigger language plpgsql security definer as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_date date := coalesce(new.date, old.date);
  v_total integer;
begin
  select coalesce(round(sum(kcal)), 0) into v_total
    from nutrition_entries where user_id = v_user and date = v_date;

  insert into daily_stats (user_id, date, calories)
  values (v_user, v_date, v_total)
  on conflict (user_id, date) do update set calories = v_total;

  return coalesce(new, old);
end;
$$;

create trigger trg_nutrition_sync
  after insert or update or delete on nutrition_entries
  for each row execute function on_nutrition_change();

create table rewards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles on delete cascade,
  name        text not null,
  icon        text default '🎁',
  cost_coins  integer not null check (cost_coins > 0),
  is_favorite boolean not null default false,
  is_archived boolean not null default false
);

create table reward_purchases (
  id           uuid primary key default gen_random_uuid(),
  reward_id    uuid not null references rewards on delete cascade,
  user_id      uuid not null references profiles on delete cascade,
  cost_paid    integer not null,
  purchased_at timestamptz not null default now()
);

-- Списание монет с проверкой баланса на стороне БД
create or replace function on_reward_purchase()
returns trigger language plpgsql security definer as $$
declare
  v_cost integer;
  v_balance integer;
begin
  select cost_coins into v_cost from rewards where id = new.reward_id;
  select coins into v_balance from profiles where id = new.user_id;

  if v_balance < v_cost then
    raise exception 'Недостаточно монет: нужно %, есть %', v_cost, v_balance;
  end if;

  update profiles set coins = coins - v_cost where id = new.user_id;
  new.cost_paid := v_cost;
  return new;
end;
$$;

create trigger trg_reward_purchase
  before insert on reward_purchases
  for each row execute function on_reward_purchase();

-- ─────────────────────────────────────────────
--  ROW LEVEL SECURITY — каждый видит только своё
-- ─────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','spheres','daily_stats','quests','quest_completions','streaks',
    'activities','activity_logs','health_settings','nutrition_entries',
    'rewards','reward_purchases'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I_owner on %I for all
       using (%s = auth.uid()) with check (%s = auth.uid())',
      t, t,
      case when t = 'profiles' then 'id' else 'user_id' end,
      case when t = 'profiles' then 'id' else 'user_id' end
    );
  end loop;
end $$;

-- Продукты: свои + глобальные видны всем, менять можно только свои
alter table products enable row level security;
create policy products_read on products for select
  using (user_id is null or user_id = auth.uid());
create policy products_write on products for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─────────────────────────────────────────────
--  ЕЖЕДНЕВНЫЙ КРОН (автоматизация)
--  Раскатывается через pg_cron в Supabase
-- ─────────────────────────────────────────────

create or replace function nightly_maintenance()
returns void language plpgsql security definer as $$
begin
  -- Первого числа месяца возвращаем заморозки стриков
  if extract(day from current_date) = 1 then
    update streaks set freezes_left = 2;
  end if;

  -- Заводим пустую строку статистики на новый день,
  -- чтобы клиент не делал upsert при каждом действии
  insert into daily_stats (user_id, date, quests_total)
  select p.id, current_date,
         (select count(*) from quests q
           where q.user_id = p.id and q.type = 'daily' and q.is_active)
    from profiles p
  on conflict (user_id, date) do nothing;
end;
$$;

-- select cron.schedule('lifequest-nightly', '5 0 * * *', 'select nightly_maintenance()');
