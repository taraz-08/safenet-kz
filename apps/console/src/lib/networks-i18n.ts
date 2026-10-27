import type { Locale } from "./schema";

const ru = {
  title: "Сети и связи", description: "Связи между аккаунтами из сохранённых публичных проверок — с источником каждого совпадения.",
  accounts: "Аккаунты", connections: "Связи", connected: "Связанные аккаунты", scans: "Публичные проверки",
  graph: "Карта связей", graphHint: "Выберите аккаунт, чтобы увидеть основания его связей. Стрелка означает ссылку из одного источника на другой.",
  noLinks: "Подтверждённых связей пока нет", noLinksHint: "Связи появятся при прямой ссылке между проверенными аккаунтами или совпадении конкретного промокода либо реферального идентификатора в материалах с признаками риска.",
  empty: "Нет подходящих публичных проверок", emptyHint: "Проверьте публичные профили или каналы. Ручной текст и загруженные файлы не подтверждают принадлежность аккаунту; автор анонимной ссылки на публикацию не угадывается.",
  demoHint: "Синтетические примеры не подтверждают связи реальных аккаунтов. Переключитесь в LIVE для просмотра сохранённых публичных проверок.",
  notice: "Связь означает наблюдаемое совпадение, а не общего владельца. Баллы риска не переносятся между аккаунтами. Общие сайты и домены соцсетей не объединяют аккаунты.",
  citation: "Прямая ссылка", promo: "Общий промокод", referral: "Общий реферальный идентификатор",
  evidence: "Основания связей", openScan: "Открыть проверку", source: "Публичный источник", all: "Все аккаунты", historical: "Исторический материал",
  latestScore: "Последний балл риска", captures: "Проверок", previous: "Назад", next: "Далее", page: "Страница", shown: "Показано на карте",
  window: "Окно: до 500 последних завершённых проверок выбранного режима.", capped: "Достигнут предел окна; показана часть сохранённых данных.",
  login: "Войти администратором", guest: "Гостевой просмотр", guestHint: "Просмотр доступен. Для запуска проверок и управления войдите администратором.",
  admin: "Администратор", localAdmin: "Администратор · локальный доступ", localHint: "Управление доступно в локальном режиме без кода входа.",
};
type Copy = Record<keyof typeof ru, string>;
const kk: Copy = {
  title: "Желілер мен байланыстар", description: "Сақталған ашық тексерулердегі аккаунттар байланысы. Әр сәйкестіктің дереккөзі көрсетіледі.",
  accounts: "Аккаунттар", connections: "Байланыстар", connected: "Байланысты аккаунттар", scans: "Ашық тексерулер",
  graph: "Байланыстар картасы", graphHint: "Байланыс негіздерін көру үшін аккаунтты таңдаңыз. Көрсеткі бір дереккөзден екіншісіне сілтемені білдіреді.",
  noLinks: "Расталған байланыстар әзірге жоқ", noLinksHint: "Тексерілген аккаунттар арасындағы тікелей сілтеме немесе тәуекел белгілері бар материалдардағы нақты промокод не реферал идентификаторы сәйкес келсе, байланыс пайда болады.",
  empty: "Тиісті ашық тексерулер жоқ", emptyHint: "Ашық профильдерді немесе арналарды тексеріңіз. Қолмен енгізілген мәтін мен жүктелген файл аккаунтқа тиесілілікті растамайды. Авторы белгісіз жарияланымның иесі болжанбайды.",
  demoHint: "Синтетикалық мысалдар нақты аккаунттардың байланысын растамайды. Сақталған ашық тексерулерді көру үшін LIVE режиміне ауысыңыз.",
  notice: "Байланыс — байқалған сәйкестік, ортақ иесінің дәлелі емес. Тәуекел балдары аккаунттар арасында берілмейді. Ортақ сайттар мен әлеуметтік желі домендері аккаунттарды біріктірмейді.",
  citation: "Тікелей сілтеме", promo: "Ортақ промокод", referral: "Ортақ реферал идентификаторы",
  evidence: "Байланыстардың негіздері", openScan: "Тексеруді ашу", source: "Ашық дереккөз", all: "Барлық аккаунттар", historical: "Тарихи материал",
  latestScore: "Соңғы тәуекел балы", captures: "Тексерулер", previous: "Артқа", next: "Келесі", page: "Бет", shown: "Картада көрсетілген",
  window: "Ауқым: таңдалған режимдегі соңғы 500 аяқталған тексеруге дейін.", capped: "Ауқым шегіне жетті; сақталған деректердің бір бөлігі көрсетілген.",
  login: "Әкімші ретінде кіру", guest: "Қонақ режимі", guestHint: "Қарауға болады. Тексерулерді бастау және басқару үшін әкімші ретінде кіріңіз.",
  admin: "Әкімші", localAdmin: "Әкімші · жергілікті қолжетімділік", localHint: "Жергілікті режимде кіру кодынсыз басқаруға болады.",
};
const en: Copy = {
  title: "Networks & connections", description: "Account relationships from saved public checks, with a source for every match.",
  accounts: "Accounts", connections: "Connections", connected: "Connected accounts", scans: "Public checks",
  graph: "Connection map", graphHint: "Select an account to inspect its connections. An arrow indicates a link from one source to another.",
  noLinks: "No supported connections yet", noLinksHint: "Connections require a direct link between checked accounts, or a shared specific promo code or referral identifier in material with observed risk indicators.",
  empty: "No eligible public checks", emptyHint: "Check public profiles or channels. Manual text and uploaded files do not verify account attribution; authors of anonymous post URLs are not inferred.",
  demoHint: "Synthetic examples do not verify real account relationships. Switch to LIVE to view saved public checks.",
  notice: "A connection describes an observation, not shared ownership. Risk scores do not propagate between accounts. Common websites and social platform domains do not group accounts.",
  citation: "Direct link", promo: "Shared promo code", referral: "Shared referral identifier",
  evidence: "Connection evidence", openScan: "Open check", source: "Public source", all: "All accounts", historical: "Historical capture",
  latestScore: "Latest risk score", captures: "Checks", previous: "Previous", next: "Next", page: "Page", shown: "Shown on map",
  window: "Window: up to 500 latest completed checks in the selected mode.", capped: "Window limit reached; only part of the saved data is shown.",
  login: "Sign in as administrator", guest: "Guest access", guestHint: "Viewing is available. Sign in as administrator to run checks and manage monitoring.",
  admin: "Administrator", localAdmin: "Administrator · local access", localHint: "Local management is available without a sign-in code.",
};
export function networkCopy(locale: Locale): Copy { return ({ ru, kk, en })[locale]; }
