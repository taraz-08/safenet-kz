/** SafeNet KZ — transparent local screening. No reputation or network checks. */
import { loadModel, predict } from './model.mjs';
const CATEGORY_LABELS = {
  lottery: 'Ақылы ұтыс / Платный розыгрыш',
  casino: 'Құмар ойын / Азартные игры',
  pyramid: 'Қаржы пирамидасының белгілері / Признаки пирамиды',
  phishing: 'Фишинг / Деректерді ұрлау',
};

const RULES = [
  ['giveaway', 'lottery', 10, 'Ұтыс туралы ұсыныс', 'Мәтінде ұтыс, лотерея немесе розыгрыш аталады.', /лотер[её]я|лотере[июй]|розыгр\w*|разыгр\w*|ұтыс\w*|ойнатамыз|utys|giveaway|raffle|lottery|lotereya|rozygr\w*|razygr\w*|рандомайзер|ойын\s*№\s*\d+|ұтыс\s+ойын\w*|күн\s+сайын\s+ойын\w*|oinatamyz|oiyn|сетк\w*\s+(?:розыгрыш|ұтыс)|сыйлық\s+кезег\w*/giu],
  ['entry_payment', 'lottery', 50, 'Қатысу үшін ақша сұралады', 'Ұтысқа қатысу билет сатып алумен, жарнамен не төлеммен байланыстырылған.', /(?:купи\w*|купить|покуп\w*|оплат\w*|стоимост\w*|цена)\s+(?:(?:себе|наш|один|лотерейный)\s+)?(?:билет\w*|номер\w*|слот\w*|участи\w*)|билет\w*\s*(?:(?:всего|за|по|стоит|от|бағасы)\s*)?\d|взнос\w*\s+(?:за|для|на)\s+участи\w*|(?:перев[её]л\w*|оплатил\w*|внес\w*|внёс\w*)\s+взнос\w*|взнос\w*\s+\d|(?:за|для)\s+участи\w*\s+(?:в\s+\w+\s+)?(?:перевед\w*|отправ\w*|оплат\w*|внес\w*)|участи\w*\s*[—–-]\s*покупк\w*|(?:оплативш\w*|кто\s+оплатил\w*)|қатысу\s+жарнасы|қатысу\s+ақысы|қатысу\s+үшін[^.!?\n]{0,40}(?:(?:\d{1,3}(?:\s\d{3})+|\d+)\s*(?:теңге|тг|₸)|(?<![\p{L}])ақша|төле\w*|аудар\w*)|қатысуға\s+\d|билет\s+сатып|ақылы\s+ұтыс|(?:buy|purchase)\s+(?:a\s+)?ticket|entry\s+(?:fee|costs?)|pay\s+to\s+enter|bilet\s+(?:satyp|\d)|qatysu\s+ushin[^.!?\n]{0,30}(?:\d|aqsha|tole)|(?:чек\w*|скрин\w*)(?:\s+(?:чека|оплаты|перевода))?\s*[—–:-]?\s*(?:в|на)?\s*(?:директ\w*|лс|личк\w*|direct)|chek\s+(?:zhiber\w*|v\s+direct)|оплатил(?:и|а)?(?![\p{L}])|кто\s+(?:уже\s+)?(?:перев[её]л|перевели)|(?:қатысу|участие|uchastie|qatysu)\s*[—–:-]?\s*(?:\d{1,3}(?:\s\d{3})+|\d+)(?:[.,]\d+)?\s*(?:₸|тг|tg|тенге|теңге|к|k)|(?:\d{1,3}(?:\s\d{3})+|\d+)\s*(?:тг|₸|tg)[^.!?\n]{0,25}за\s+участи\w*|спасибо\s+за\s+оплату|төлем\s+үшін\s+рахмет|кезекке\s+тұру\s*[—–:-]?\s*\d|(?:төледім|toledim)/giu],
  // Numbers/slots sold for a draw are a stronger cue than generic tickets (concerts also sell tickets).
  ['slot_purchase', 'lottery', 50, 'Нөмір не слот сату', 'Ұтыс нөмірі, слоты не орны белгілі бағамен сатылады.', /(?:номер\w*|нөмір\w*|слот\w*|slot\w*|nomer\w*|орын)\s*(?:[=—–:×xх*-]|по|за|стоит|бағасы)?\s*(?:\d{1,3}(?:\s\d{3})+|\d+)\s*(?:тг|тенге|теңге|₸|tg|tenge|к|k|тыс\w*|мың)(?![\p{L}])(?!\s*(?:\/|в|за)\s*(?:сутки|ночь|час))|(?:номер\w*|номерочк\w*|слот\w*|орын)\s+(?:по\s+)?(?:косар\w*|пятихат\w*|(?:одн\w*|одна|две|два|три|пять|десять|бір|екі|үш|бес|он)\s+(?:тысяч\w*|тыщ\w*|мың))|(?:беру|бер[её]м|взял[аи]?|оплатил[аи]?)\s+(?:\d+|два|две|три|один|одну)?\s*(?:номер\w*|слот\w*)|(?:\d+|два|две|три)\s+слот\w*\s+взял\w*|номер\w*\s+по\s+\d|(?:бір|1|одно)\s+(?:нөмір|орын|место)\s*[=—–:-]?\s*\d|оплат\w*\s+слот\w*|(?:номер\w*|нөмір\w*|слот\w*|slot\w*|nomer\w*|орын|oryn|клетк\w*|место)\s*(?:[=—–:×xх*-]|по|за)?\s*\d+[.,]\d+\s*(?:к|k)(?![\p{L}])|(?:1|бір|bir)\s+(?:oryn|bilet|билет)\s*[=—–:-]?\s*\d|клетк\w*\s+по\s+\d|(?:каждый|әр)\s+номер\w*\s*[—–:-]?\s*\d|(?:әр|каждые)\s+(?:\d{1,3}(?:\s\d{3})+|\d+)\s*(?:₸|тг|tg)\s*[—–-]?\s*(?:бір|один|1)\s+(?:билет|шанс|номер\w*|нөмір)|\d+\s*(?:тг|₸)?\s*(?:на\s+каспи)?\s*=\s*1\s+шанс|(?:маған|magan|мне)\s+(?:\d+|бір|екі|үш|bir|eki|ush)\s+(?:нөмір|nomer|номер\w*)|(?:төледім|оплатил\w*|skinul\w*|скинул\w*)\s+(?:\d+\s+)?(?:нөмір|номер\w*|nomer)|под\s+номером\s+\d|pod\s+nomerom|номер\w*\s+по\s+полтор\w*/giu],
  ['random_draw', 'lottery', 10, 'Жеңімпазды кездейсоқ анықтау', 'Жеңімпаз рандомайзер, дөңгелек не тікелей эфирдегі жеребе арқылы анықталады.', /рандом\w*|random\.org|randomizer|колес\w*|🎡|крутим(?![\p{L}])|айналдыр\w*|krutim|барабан\w*|жеребь[её]в\w*|случайн\w*\s+(?:образом|выбор\w*|числ\w*|номер\w*)|генератор\w*\s+(?:случайн\w*|чисел)|(?:определ\w*|выбер\w*|разыгра\w*)[^.!?\n]{0,25}(?:в\s+)?прям\w*\s+эфир\w*|тікелей\s+эфир\w*|кездейсоқ|дөңгелек\w*|efir\w*|random\w*|randoma\w*|koleso|генератор\w*|efirde/giu],
  ['organizer_income', 'lottery', 14, 'Ұйымдастырушының табысы', 'Нөмірлер мен слоттар саны, жиналған сома не сатылым ұйымдастырушы ақша жинайтынын көрсетеді.', /(?:всего|осталось|остались|ещё|еще|последн\w*)\s+(?:\d+|три|два|две|пять|десять)\s+(?:свободн\w*\s+)?(?:номер\w*|слот\w*|билет\w*)|свободн\w*\s+(?:номер\w*|слот\w*)|(?:все\s+)?(?:номера|слоты)\s+(?:занят\w*|распродан\w*|раскуплен\w*)|собрал\w*\s+(?:уже\s+)?\d+\s+(?:номер\w*|слот\w*|участник\w*)|после\s+(?:сбора|набора)\s+(?:всей\s+)?(?:суммы|номеров|слотов)|продаж\w*\s+(?:номер\w*|слот\w*)|всего\s+\d+\s+(?:номер\w*|слот\w*|мест)|қалған\s+\d+\s+(?:орын|нөмір)|\d+\s+(?:орын|нөмір)\s+қалды|орын\s+саны\s+шектеулі|беру\s+\d+\s+номер\w*|(?:слот|номер|мест)\w*\s+(?:(?:ещё|еще)\s+)?(?:свободн\w*|есть)(?![\p{L}])|вс[её]\s+(?:продано|распродано|раскуплено)|(?:слот|орын|нөмір)\w*\s+қалды|всего\s+(?:(?:\d{1,3}(?:\s\d{3})+|\d+)|\p{L}+\s+тысяч\w*)\s+слот\w*|набор\w*\s+(?:на\s+колесо|слотов|номеров)|осталось\s+\d+\s+мест\w*|пока\s+не\s+набер\w*|(?:всего|барлығы|barlygy)?\s*\d+\s+(?:нөмір|орын|oryn|клетк\w*)(?![\p{L}])|сетк\w*\s+(?:жабыл\w*|закрыва\w*|закрыт\w*)|setka\w*\s+jab\w*|выкуп\w*|набира\w*\s+\d+\s+(?:человек|адам|участник\w*)|(?:\d+\s+адам|нөмір|сетка)\s+толғанда|нөмір\s+толса|toly\s+bolganda|kak\s+naber\w*|орг\.?\s*сбор\w*|songgy\s+\d+\s+oryn/giu],
  ['series', 'lottery', 6, 'Ұтыстар сериясы', 'Ұтыс тұрақты өтетіні көрсетілген: нөмірленген не апта сайынғы ұтыс.', /розыгрыш\w*\s*№\s*\d+|(?:каждую|каждый)\s+(?:неделю|день|месяц|пятницу|субботу)\s+разыгр\w*|(?:новый|следующий|еженедельн\w*|ежедневн\w*)\s+розыгрыш\w*|апта\s+сайын\s+ұтыс\w*|№\s*\d+\s+стартовал\w*|розыгрыш\w*\s+(?:\p{L}+\s+)?номер\s+\p{L}+|это\s+уже\s+\d+-?й/giu],
  ['casino_mention', 'casino', 34, 'Құмар ойын атауы', 'Казино, букмекер, слот немесе ставкаға қатысты сөздер табылды.', /казино|казик\w*|к[аa@]з[иi1]н[оo0]|casino|cas[i1]n[o0]|k[a@4]z[i1]n[o0]|ka3ino|kazik|[кk][\s.\-_*]{1,2}[аa@][\s.\-_*]{1,2}[зz3][\s.\-_*]{1,2}[иi1][\s.\-_*]{1,2}[нn][\s.\-_*]{1,2}[оo0]|букмекер\w*|бук\s+контор\w*|1xbet|1хбет|pinup|pin-up|пинап|mostbet|мостбет|betwinner|melbet|pokerdom|покердом\w*|vavada|вавада|azino\s?777|азино\s?777|standbat+l+e|ст[еэ]ндбатл\w*|stndbtl|додеп\w*|dodep\w*|заносы\s+(?:недели|дня|стример\w*|со\s+стрим\w*)|слот(?:ы|ов|ах|ам|е|у|ом|тар|тарды)?(?![\p{L}])|слотик\w*|\bslots\b|фриспин\w*|free\s*spins|бонуск\w*|рулетк\w*|игров\w*\s+автомат\w*|ойын\s+автомат\w*|ставк[а-я]*\s+на\s+(?:спорт|матч)|спортқа\s+бәс|құмар\s+ойын\w*|(?:на|за)\s+реальн\w*\s+(?:деньг\w*|монет\w*)|моментальн\w*\s+вывод\w*|вывод\w*\s+моментальн\w*|зел[её]н\w*\s+стол\w*|🎰|🍒{2,}|🍒🍋|🍋🍒|«?жеміс\w*»?\s+(?:ойын\w*|берді)|«жеміс\w*»|«ракетк\w*»|ракетк\w*\s+(?:[xх]\d|\d[xх])|«авиатор\w*»|aviator|краш[\s-]?игр\w*|игр\w*\s+краш\w*|сигнал\w*\s+(?:топ\w*|групп\w*|канал\w*)|множител\w*\s*[xх×]?\s*\d+/giu],
  ['gambling_action', 'casino', 24, 'Ойынға шақыру', 'Ойын ойнауға, ставка жасауға немесе казиноға тіркелуге шақыру бар.', /(?<![\p{L}])(?:играй(?:те)?|зарабатывай(?:те)?|жми(?:те)?|переходи(?:те)?|регистрируй(?:ся|тесь)|регай(?:ся|тесь)|крути(?:м|те)?|крутанем|ставь(?:те)?|делай\s+ставк\w*|ставки\s+принимаются|залетай(?:те)?|забирай(?:те)?)(?![\p{L}])|ойна(?:ңыз|п|уға|ймыз)?(?![\p{L}])|тіркел(?:іңіз)?(?![\p{L}])|бәс\s+тік|play\s+now|place\s+(?:your\s+)?bets|sign\s+up|tirkel|oin[aä]|зарега\w*/giu],
  ['bonus', 'casino', 17, 'Бонуспен ынталандыру', 'Бонус, промокод немесе тегін айналым ойынға тарту үшін қолданылуы мүмкін.', /бонус\w*|промокод\w*|промо(?![\p{L}])|промик\w*|promo(?![\p{L}])|\d+\s*fs(?![\p{L}])|фриспин\w*|free\s*spins|бездеп\w*|кэшб[еэ]к\w*\s+(?:\d+\s*%\s+)?на\s+проигр\w*|bonus\w*|promo\s*code|тегін\s+айналым|tegin\s+spin/giu],
  ['deposit', 'casino', 17, 'Депозит енгізу', 'Шотқа ақша салу немесе депозитті толықтыру ұсынылады.', /депозит\w*|пополн(?:и|е|я)\w*|толықтыр\w*|деп(?:у|а|ом|чик|ни|нул\w*|ну)?(?![\p{L}])|задеп\w*|deposit\w*|depozit\w*|депа\w*|депнул\w*/giu],
  // Hidden promotion: personal "wins" used as native advertising.
  ['native_win', 'casino', 22, 'Жасырын жарнама: «менің ұтысым»', 'Ұтыс, ақша шығару не «занос» туралы жеке әңгіме ойын сайтына тартатын жасырын жарнама болуы мүмкін.', /мой\s+выигрыш|выиграл\w*\s+\d|поднял\w*\s+(?:\d|бабл\w*|деньг\w*|денег|кэш|кеш|кусок)|как\s+я\s+поднял\w*|поднял[аи]?»?\s+на\s+\p{L}+|где\s+подн\w*|(?:сделать|поднять)\s+сотку|\+\s?\d+\s?(?:к|k)(?![\p{L}])|вывел\w*\s+\d|вывод\w*\s+(?:\d|пришёл|пришел|одобрен|(?:на\s+\p{L}+\s+)?за\s+\d+\s+мин\w*)|(?:реально|моментально|быстро)\s+вывод\w*|занос\w*|отбил\w*\s+деп\w*|(?<![\p{L}\p{N}])[xх]\s?\d{2,4}(?![\p{L}\p{N}])|сорвал\w*\s+(?:куш|джекпот)|ұтып\s+алдым|ақша\s+шығардым|где\s+(?:я\s+)?играю|где\s+играешь|играю\s+тут|қай\s+жерде\s+ойна\w*|qai\s+jerde\s+oina\w*|ойын\s+аты|ойнап\s+жүрмін|шығарып\s+алдым|shygardym|ақша\s+шығару|вывел[аи]?\s+(?:сразу\s+)?на\s+(?:каспи|kaspi|карт\w*)|за\s+(?:неделю|вечер|день|час|месяц)\s+\+?\d+\s*(?:к|k|тыс\w*|000)(?![\p{L}])|закинул[аи]?\s+(?:\d{1,3}(?:\s\d{3})+|\d+)[^.!?\n]{0,30}было\s+\d/giu],
  ['mirror', 'casino', 24, 'Сайттың айнасы', 'Бұғатталған сайтты айналып өтуге арналған «жұмыс айнасы» не жаңа мекенжай ұсынылады.', /(?:рабоч\w*|актуальн\w*|нов\w*|свеж\w*|резервн\w*)\s+зеркал\w*|зеркал\w*\s+(?:сайта|казино|для\s+входа|на\s+сегодня)|обход\w*\s+блокировк\w*|зеркал\w*\s+(?:сменил\w*|обнов\w*|поменял\w*|ауысты|№\s*\d)|(?:обновил|сменил|поменял)\w*\s+зеркал\w*|(?:основной\s+)?сайт\s+не\s+(?:открывается|грузит)|старый\s+сайт\s+заблокирован\w*|ескі\s+сілтеме\s+ашылмайды|mirror\s+(?:link|site)|жұмыс\s+айна\w*|жұмыс\s+істейтін\s+айна|jumys\s+isteitin\s+zerkalo|негізгі\s+сайт\s+бұғатталған|negizgi\s+sait|(?:сілтемелер|ссылки)\s+(?:мен|и)\s+зеркал\w*|vpn\s+(?:қосыңыз|включите)|zerkalo/giu],
  ['proxy_redirect', 'casino', 12, 'Делдал арқылы бағыттау', 'Сілтеме тікелей берілмейді: бекітілген хабарға, сипаттамаға не жеке хатқа жібереді.', /(?:пиши|пишите|напиши|напишите|жду)\w*\s+(?:в\s+)?(?:лс|личк\w*|директ|dm|личные)\s+(?:за\s+)?(?:ссылк\w*|промо\w*|линк\w*)|(?:ссылк|линк)\w*\s+(?:\p{L}+\s+){0,2}в\s+(?:закреп\w*|шапк\w*|описани\w*|коммент\w*|сторис|тг|телег\w*)|ssylka\s+v\s+tg|все\s+ссылки\s+в\s+\w+|за\s+ссылкой\s+в\s+(?:лс|директ|личк\w*)|сілтеме\s+(?:сипаттамада|бекітілген)|скину\s+ссылк\w*|сілтемені\s+директке|сілтеме\s+закреп\w*|silteme\s+bio/giu],
  ['investment', 'pyramid', 11, 'Инвестиция ұсынысы', 'Ақша салу, инвестиция немесе табыс алу ұсынысы бар.', /инвест\w*|влож\w*|табыс\w*|қаржы\s+сал|ақша\s+сал|салым\w*|доход\w*|пассив\w*\s+заработ\w*|пассивк\w*|вход\w*\s+от\s+\d|vkhod\s+ot|investment\w*|invest\w*|profit\w*|tabys\w*|vlozh\w*|salym\w*|взнос\w*|пайда\w*|жоба\w*|проект\w*\s+(?:и\s+команд|инвест)/giu],
  ['guaranteed_profit', 'pyramid', 33, 'Кепілдендірілген табыс уәдесі', 'Тәуекелсіз не кепілді табыс уәдесі — тексеруді қажет ететін белгі.', /(?:гарантирован\w*|гаранти\w*)\s+(?:(?:высок\w*|ежедневн\w*|вам|твой)\s+)?(?:доход\w*|прибыл\w*|заработ\w*|возврат\w*|\d+\s*%)|стабильн\w*\s+(?:доход\w*|прибыл\w*)\s+(?:от\s+)?\d+(?:[.,]\d+)?\s*%|(?:доход\w*|прибыл\w*|табыс\w*)\s+(?:гарантирован\w*|кепіл\w*)|\d+\s*%\s+(?:[\p{L}]+\s+){0,3}гарантированн\w*|гарантия\s+100\s*%|100\s*%\s+гаранти\w*|(?:без|безо)\s+риск\w*|тәуекелсіз|кепілдендірілген\s+(?:табыс|пайда)|кепілді\s+(?:табыс|пайда)|guaranteed\s+(?:return\w*|profit\w*|income)|risk[-\s]?free|bez\s+riska|garantiya\s+100|kepildik|100\s*%\s+kepil\w*/giu],
  ['fast_returns', 'pyramid', 24, 'Қысқа мерзімдегі жоғары табыс', 'Күндік, апталық жоғары пайыз не ақшаны тез көбейту уәдесі көрсетілген.', /\d+(?:[.,]\d+)?\s*%\s*(?:(?:доход\w*|прибыли|табыс)\s*)?(?:в\s+(?:день|сутки|неделю)|за\s+(?:день|сутки|неделю)|ежедневно|күн(?:де|іне)|аптасына|per\s+(?:day|week)|daily|weekly)|(?:[1-9]\d|\d{3,})\s*%\s*(?:в|за)\s+месяц|айына\s+(?:[1-9]\d|\d{3,})\s*%|күніне\s+\d+(?:[.,]\d+)?\s*%|(?:один|два|три|пять|десять|\d+)\s+процент\w*\s+(?:в|за)\s+(?:день|сутки|неделю)|(?:\d+\s*)?%\s+каждый\s+день|\d+\s*%\s*v\s+den\w*|(?:удво\w*|утро\w*)\s+(?:свои\s+|ваши\s+)?(?:деньги|вклад\w*|капитал\w*)|ақша\w*\s+(?:екі|2)\s+есе|(?:екі|үш|\d)\s+есе\s+(?:көп|артық)|double\s+your\s+money|(?<![\p{L}\p{N}])(?:[2-9]x|[xх][2-9])\s+(?:за|in|через)\s+\d|в\s+(?:два|три|2|3)\s+раза\s+больше|(?<![\p{L}\p{N}])(?:[2-9][xх]|[xх]\s?[2-9](?:[.,]5)?)(?![\p{L}\p{N}])\s*(?:за|через|в|in)?\s*(?:\d+\s*)?(?:недел\w*|дн\w*|день|сутк\w*|месяц\w*|час\w*)|выплат\w*[^.!?\n]{0,15}(?:[2-9][xх]|[xх]\s?[2-9])(?![\p{L}\p{N}])|(?:екі|үш|\d)\s+есе\s+(?:көбейт\w*|ал\w*)|окупа\w*\s+за\s+\d+\s*(?:дн|день|час|недел)|(?:әр\s+)?апта\w*\s+(?:\p{L}+\s+){0,2}\d+\s*%|\d+\s*%\s+(?:пайда|табыс)\s+(?:в\s+неделю|апта\w*|күн\w*)|\d+\s*%\s+пайда\s+в\s+(?:неделю|день)/giu],
  ['recruitment', 'pyramid', 27, 'Қатысушы әкелгені үшін сыйақы', 'Жаңа адамдарды тарту табыспен немесе құрылымдағы деңгеймен байланыстырылуы мүмкін.', /(?:привед\w*|приглас\w*|приводи\w*)\s+(?:(?:\d+|двух|двое|двоих|тр[её]х|трое|троих|одного|новых|своих)\s+)?(?:друз\w*|людей|участник\w*)|привод\w*\s+(?:двоих|троих|\d+)|(?:доход\w*|процент\w*|бонус\w*|вознагражден\w*)\s+(?:за|с)\s+(?:новых\s+|каждого\s+)?(?:участник\w*|приглаш\w*|привлеч\w*)|за\s+каждого\s+(?:приглаш\w*|нового|друга|участник\w*)|приглашаешь\s*[—–-]\s*бонус|реферал\w*\s+(?:систем\w*|доход\w*|выплат\w*|бонус\w*)|приведи\s+друга|(?:приглас\w*|привед\w*)\s+подруг\w*|за\s+каждую\s+подруг\w*|(?:процент\w*|%)\s+(?:от|с)\s+(?:её|его|их)?\s*вклад\w*|дос\w*\s+(?:шақыр\w*|әкел\w*)|ертіп\s+кел\w*|әр\s+(?:шақырған\s+)?адам\s+үшін|(?:\d+\s+)?адам\s+шақыр\w*|invite\s+(?:\d+\s+)?(?:friends|people)|recruit\s+members|dos\w*\s+shaqyr\w*|priglasi\s+druz\w*|(?:приглаша\w*|привед\w*|привод\w*)\s+(?:\d+\s+)?(?:человек\w*|адам)|\d+\s*%\s+с\s+(?:их\s+)?взнос\w*|шақырыл\w*\s+дос\w*|\d+\s*%\s+(?:әр\s+)?шақырған|(?:кто|кім)\s+приглаша\w*\s*[—–-]?\s*бонус/giu],
  ['structure', 'pyramid', 22, 'Желілік ақша құрылымы', 'Матрица, төменгі деңгейлер не жаңа қатысушылардың салымымен төлеу белгілері бар.', /матриц\w*|нижестоящ\w*|нижн\w*\s+уровн\w*|(?:со?\s+)?\d+\s+уровн\w*\s+(?:ид\w*|получ\w*|начисл\w*)|денежн\w*\s+круг\w*|касс[аы]\s+взаимопомощи|выплат\w*\s+за\s+сч[её]т\s+нов\w*|отправля\w*\s+верхн\w*|верхн\w*\s+(?:участник\w*|уровн\w*)|\d\s+лини[яи]\s*[—–:-]\s*\d+\s*%|қаржы\s+пирамида\w*|финансов\w*\s+пирамид\w*|ponzi|pyramid\s+scheme|лепест\w*|схем\w*\s+цветк\w*|«?сердц\w*»?\s+цветк\w*|подари\s+подарок|денежн\w*\s+(?:самол[её]т|цвет\w*)|\d+\s*деңгей\w*|төменгі\s+деңгей\w*|деңгей\w*\s+(?:жүйесі|құрылым\w*)|\d+\s+адам\s+толса|выплат\w*\s+(?:будут\s+в|вне\s+очереди|по\s+очереди|задерж\w*)/giu],
  ['curator', 'pyramid', 12, 'Кураторлар мен көшбасшылар', 'Ақша аударуды «куратор», «наставник» не «лидер» қабылдайды — топ құрылымының белгісі.', /куратор\w*|наставник\w*|топ[-\s]?лидер\w*|лидер\w*\s+(?:команд\w*|структур\w*)|спасибо\s+организатор\w*|жетекші\w*|kurator\w*|кассир\w*/giu],
  ['payout_proof', 'pyramid', 20, 'Төлем «дәлелдері» мен пікірлер', 'Төлем скриншоттары не «бәрі адал» деген пікірлер жаңа адамдарды «қыздыру» үшін қолданылуы мүмкін.', /скрин\w*\s+(?:выплат\w*|вывод\w*)|выплат\w*\s+(?:пришл\w*|получил\w*|снова|сегодня)|снова\s+выплат\w*|вот\s+(?:мои|наши)\s+(?:выплат\w*|\d)|мои\s+выплат\w*|выплат\w*\s+(?:за\s+\S+\s+)?произведен\w*|реестр\s+выплат|отзыв\w*\s+инвестор\w*|вывел[аи]?\s+(?:второй|третий|уже|\d)|перевод\s+выполнен|реально\s+плат\w*|вс[её]\s+честно|отзыв\w*\s+участни\w*|ақша\s+түсті|төлем\s+түсті|төлем\w*\s+келді|тағы\s+бір\s+төлем|екінші\s+төлем\w*|пришла\s+выплата|бәрі\s+уақытында\s+төленді/giu],
  // Payment channels are shared evidence: draws and pyramids both route money to personal cards.
  ['kaspi_transfer', 'shared', 12, 'Жеке картаға / Kaspi-ге аудару', 'Ақшаны Kaspi арқылы не жеке картаға аудару сұралады; ұйымның ресми төлемі емес болуы мүмкін.', /(?:перевод\w*|переведи\w*|переводи\w*|скинь|скидыва\w*|кинь|кидай|закидыва\w*|закинь|отправ\w*|оплат\w*|пополнени\w*)[^.!?\n]{0,25}(?:kaspi|каспи|карт[уыа]|номер\s+(?:каспи|kaspi|куратор\w*))|kaspi\s*gold|каспи\s+голд|номер\s+(?:каспи|kaspi)|(?:kaspi|каспи)[\s-]*(?:ге|ға|ga|ge)?\s+(?:аудар\w*|audar\w*)|(?:kaspi|каспи)[\s-]*(?:ге|ға|ga|ge)(?![\p{L}])|аудар\w*\s+(?:kaspi|каспи)|личн\w*\s+карт\w*|4400\s*\*{4}|perevod\s+na\s+kaspi|(?:kaspi|каспи)\s*[:\-—]?\s*\+?\s*[78][\s(-]*\d{3}|(?:kaspi|каспи)\s+(?:в\s+(?:шапке|профиле|био|описании)|по\s+номеру|тот\s+же|tot\s+zhe)|(?:оплат|перевод)\w*\s+на\s+(?:тот\s+же|этот|мой|наш)\s+номер|реквизит\w*\s+(?:в\s+шапке|как\s+обычно|в\s+профиле|в\s+лс)|na\s+kaspi|(?:kaspi|каспи)[\s-]*перевод\w*|(?:kaspi|каспи)\s+нөмір\w*|(?:kaspi|каспи)\s+arqyly|kaspi['’]ge/giu],
  ['sensitive_request', 'phishing', 58, 'Құпия код немесе дерек сұралады', 'SMS/OTP кодын, парольді немесе карта құпиясын басқа адамға жіберу сұралады.', /(?:пришл\w*|отправ\w*|сообщ\w*|назов\w*|введ\w*|скинь\w*|напиш\w*)\s+(?:(?:мне|нам|свой|ваш|этот|полученный|сюда|в\s+чат)\s+){0,3}(?:смс[-\s]?(?:код)?|sms[-\s]?(?:код)?|код\s+(?:из|от)\s+(?:смс|sms|сообщения)|otp|парол\w*|cvv|cvc|пин[-\s]?код)|(?:скинь|пришли|назови|продиктуй|отправь)\w*\s+(?:мне\s+)?(?:\d|четыре|пять|шесть)\s*(?:цифр|символ)\w*|(?:sms|смс)[-\s]*(?:код\w*|кодын)\s+(?:маған\s+|бізге\s+)?(?:жібер\w*|айт\w*|енгіз\w*)|(?:құпия\s*сөз\w*|парол\w*|cvv|cvc)\s+(?:жібер\w*|айт\w*|енгіз\w*)|(?:send|share|tell\s+me|enter)\s+(?:your\s+|the\s+)?(?:otp|password|sms\s+code|verification\s+code|cvv)|sms\s+kod\w*\s+zhiber\w*/giu],
  ['account_threat', 'phishing', 18, 'Аккаунтты бұғаттаумен қорқыту', 'Бұғаттау немесе қолжетімділікті жоғалту туралы қысым бар.', /(?:аккаунт\w*|уч[её]тн\w*\s+запис\w*|карт[ауы]|профил\w*|сч[её]т)\s+(?:(?:будет|скоро|может\s+быть|уже)\s+)?(?:заблокир\w*|удал[её]н\w*|бұғат\w*)|(?:аккаунт|карта|профиль|шот)\p{L}*\s+бұғаттал\w*|account\s+(?:(?:will\s+be|is)\s+)?(?:blocked|suspended|deleted)/giu],
  ['login_request', 'phishing', 30, 'Сілтеме арқылы растау сұралады', 'Логинді, аккаунтты немесе банк деректерін сілтеме арқылы растау сұралады.', /(?:подтверд\w*|верифицир\w*)\s+(?:свой\s+|ваш\s+)?(?:аккаунт\w*|личност\w*|профил\w*|банковск\w*\s+данн\w*|карт\w*)|аккаунт\w*\s+раста\w*|verify\s+(?:your\s+)?(?:account|identity|card)|войд\w*\s+(?:в\s+)?(?:аккаунт\w*|профил\w*)\s+по\s+ссылк\w*/giu],
  ['impersonation', 'phishing', 8, 'Банк не қолдау қызметі аталады', 'Банк немесе қолдау қызметінің атауы басқа күмәнді белгілермен бірге кездеседі.', /kaspi|каспи|halyk|халык|халық\s+банк|служб\w*\s+(?:безопасности|поддержки)|техподдерж\w*|қолдау\s+қызмет\w*|support\s+team|instagram\s+support|tiktok\s+support/giu],
  ['urgency', 'shared', 9, 'Асықтыру немесе шектеулі уақыт', 'Тез шешім қабылдататын уақыт қысымы бар.', /срочно|только\s+сегодня|остал[оа]сь\s+(?:\d+|три|два|пять|всего)\s+(?:мест|минут|час)|мест\w*\s+(?:ограничен\w*|заканчива\w*|мало)|(?:набор|поток)\s+закрыва\w*|последн\w*\s+(?:шанс|день)|до\s+конца\s+дня|успей\w*|успевай\w*|қазір\s+ғана|тек\s+бүгін|соңғы\s+(?:күн|мүмкіндік)|орын\s+(?:саны\s+)?шектеулі|\d+\s+орын\s+қалды|үлгер\w*|тезірек|шұғыл|urgent|act\s+now|today\s+only|srochno|ostalos\s+\d+\s+mest|до\s+(?:пятницы|понедельника|вторника|среды|четверга|субботы|воскресенья|конца\s+недели)|кім\s+кіреді|кто\s+(?:ещё\s+)?(?:заходит|зайд[её]т)|орын\s+мало|tek\s+\d+\s+oryn|топ\s+жабылады|вход\s+закрыт/giu],
  ['payment', 'shared', 10, 'Ақша аударуға шақыру', 'Ақша аудару, жарна енгізу не төлем жасау сұралады.', /перевед\w*\s+(?:(?:мне|нам|на\s+карту|всего)\s+){0,2}(?:\d|деньги|сумм\w*)|отправ\w*\s+(?:\d|деньги)|внес\w*\s+(?:вклад\w*|взнос\w*|\d)|ақша\s+(?:аудар\w*|жібер\w*|сал\w*)|(?:\d{1,3}(?:\s\d{3})+|\d+)\s*(?:₸|тг|тенге|теңге)\s+(?:аудар\w*|жібер\w*)|send\s+(?:money|\d)|transfer\s+(?:money|\d)/giu],
];

const WARNING = /(?:не\s+(?:переводите|отправляйте|сообщайте|переходите|играйте|участвуйте|вкладывайте|вводите|передавайте|верьте|ведитесь|попадайтесь|связывайтесь)|не\s+дайте\s+себя|никому\s+не|осторожно|будьте\s+бдительн\w*|против\s+мошенничества|как\s+(?:распознать|отличить|не\s+попасться|работает\s+(?:схема|развод|лохотрон))|чтобы\s+не\s+попаст\w*|признак\w*\s+(?:\p{L}+\s+)?(?:фишинга|пирамид\w*|мошенничеств\w*|незаконн\w*|лохотрон\w*|казино|лотере\w*)|разоблачени\w*|незаконн\w*\s+реклам\w*|сообщайте\s+о|предупрежда\w*|правильн\w*\s+ответ|(?<![\p{L}])квиз|(?:скинул\w*|прислал\w*|написал\w*)\s+(?:\p{L}+\s+){0,4}«|мошенническ\w*\s+схем\w*|финансов\w*\s+грамотност\w*|повод\s+насторожиться|обманут\w*\s+(?:вкладчик\w*|людей|граждан)|это\s+(?:скам|обман)|алаяқтық\s+белгілері|қаржылық\s+сауаттылық|сақ\s+бол\w*|абай\s+бол\w*|алданбаңыз|жібермеңіз|айтпаңыз|аудармаңыз|сенбеңіз|ойнамаңыз|тіркелмеңіз|толықтырмаңыз|ақша\s+салмаңыз|do\s+not\s+(?:send|share|click|invest)|never\s+(?:send|share)|scam\s+alert|жалған\s+парақша|ешқашан\s+(?:\p{L}+\s+){0,4}алмаймыз|ресми\s+парақша|поддельн\w*\s+(?:страниц|аккаунт)|никогда\s+не\s+(?:берём|просим|собираем)|объясняю|для\s+начинающих|нормальн\w*\s+доходност\w*)/giu;
// Law-enforcement and newsroom phrasing (AFM, police, courts) describes a scheme rather than offering it.
const REPORT = /(?:полици[яи]\s+(?:выявила|задержала|сообщила|предупреждает)|сообщает\s+полиция|(?:департамент\w*|управлени\w*)\s+полиции|суд\s+(?:приговорил|признал|санкционировал|арестовал)|в\s+новостях\s+сообщили|по\s+данным\s+(?:следствия|полиции|афм|мвд)|пресечен\w*|пресекл\w*|задержан\w*|возбужд[её]н\w*\s+уголовн\w*|уголовн\w*\s+дел\w*|досудебн\w*\s+расследовани\w*|расследовани\w*\s+(?:продолжается|окончено)|мера\s+пресечения|подозреваем\w*|изъят\w*|агентств\w*\s+по\s+финансовому\s+мониторингу|(?<![\p{L}])афм(?![\p{L}])|прокуратур\w*\s+(?:выявил\w*|предупреждает)|қаржылық\s+мониторинг\s+агенттігі|қылмыстық\s+іс\w*|сотқа\s+дейінгі\s+тергеу|тергеу\s+(?:барысында|жалғасып)|ұсталды|күдікті\w*|тәркіленді|зерттеу|зерттеуші\w*|полиция\s+(?:анықтады|ескертеді|ұстады)|news\s+report|research\s+(?:on|shows)|эксперт\w*\s*:|исследовани\w*\s+показ\w*|опрос\w*\s+показ\w*|каждый\s+(?:второй|третий|пятый)|осужден\w*|приговор\w*|ущерб\w*|потерпевш\w*|қаржы\s+мониторинг\w*\s+агенттіг\w*|анықтады|ұсынылады)/giu;
const QUOTED_WARNING = /(?:мошенники|алаяқтар|scammers)\s+(?:пишут|просят|обещают|предлагают|жазады|сұрайды|ұсынады|уәде\s+береді|ask|promise)/giu;
const PROMO_LINK = /(?:ссылка\s+(?:в\s+био|ниже|в\s+профиле|в\s+шапке\s+профиля)|сілтеме\s+(?:биода|профильде)|link\s+in\s+bio|профильдегі\s+сілтеме\w*|silteme\s+bio\w*|сілтеме\s+в\s+профиле)/giu;
// Free-contest markers explain a low score; they never subtract weight from an explicit payment.
const FREE_ENTRY = /(?:участие|участвовать)\s+(?:абсолютно\s+)?бесплатн\w*|бесплатн\w*\s+(?:розыгрыш\w*|участи\w*|купон\w*)|покупать\s+ничего\s+не\s+нужно|(?:платить|оплачивать)\s+(?:за\s+участие\s+)?не\s+нужно|без\s+(?:оплаты|взнос\w*)(?!\s+не)|никаких\s+взнос\w*|подпи\w*[^.!?\n]{0,40}(?:лайк|репост|отметь\w*)|отметь\w*\s+(?:двух\s+|друга|друзей|\d+)|қатысу\s+тегін|тегін\s+ұтыс|ақша\s+сұрамаймыз|free\s+(?:giveaway|raffle)|no\s+(?:entry\s+fee|purchase)/giu;
// Narrow imperatives distinguish a direct offer from a report quoting one.
// This is a context heuristic, not a semantic model or a safety determination.
const DIRECT_ACTION = /(?<![\p{L}\p{N}])(?:пополни(?:те)?|внеси(?:те)?|вложи(?:те)?|переведи(?:те)?|переводи(?:те)?|отправь(?:те)?(?=\s+(?:мне\s+|нам\s+)?(?:\d|деньг|сумм|взнос|код|на\s+(?:карт|каспи|kaspi|номер)))|пришли(?:те)?(?=\s+(?:мне\s+|нам\s+)?(?:\d|деньг|сумм|код|смс|sms|парол))|играй(?:те)?|регистрируй(?:ся|тесь)|регай(?:ся|тесь)|переходи(?:те)?|жми(?:те)?|купи(?:те)?|введи(?:те)?|депни|залетай(?:те)?|закидывай(?:те)?|вкладывай(?:те)?|толықтыр(?:ыңыз)?|тіркел(?:іңіз)?|ойна(?:ңыз)?|ақша\s+сал(?:ыңыз)?|ақша\s+аудар(?:ыңыз)?|код(?:ты|ын)?\s+жібер(?:іңіз)?|play\s+now|sign\s+up|send\s+(?:money|your\s+(?:password|code)))(?![\p{L}\p{N}])/giu;

function directActionOutsideReport(content) {
  const quotes = [...content.matchAll(/«[^»]*»|“[^”]*”|"[^"\n]*"/gu)].map(match=>[match.index,match.index+match[0].length]);
  for(const match of content.matchAll(DIRECT_ACTION)) {
    if(quotes.some(([start,end])=>match.index>=start && match.index<end))continue;
    const before=content.slice(Math.max(0,match.index-240),match.index);
    const clause=before.slice(Math.max(before.lastIndexOf('.'),before.lastIndexOf('!'),before.lastIndexOf('?'),before.lastIndexOf('\n'))+1);
    if(/(?:не|никогда\s+не|не\s+стоит|нельзя|не\s+нужно|не\s+надо|do\s+not|don't|never)\s*$/iu.test(clause))continue;
    // A reported instruction is evidence of what was said, not the source's offer.
    const prefix=normalizeWithMap(clause);
    if(firstMatch(QUOTED_WARNING,prefix) || firstMatch(REPORT,prefix))continue;
    return {quote:match[0],index:match.index};
  }
  return null;
}

function normalizeWithMap(value) {
  let normalized = '';
  const positions = [];
  const source = String(value ?? '').slice(0, 30000);
  for (let i = 0; i < source.length; i++) {
    if (/[\u200B-\u200D\u2060\uFEFF]/u.test(source[i])) continue;
    // A run of whitespace counts once: overlapping \s quantifiers in rules then cannot backtrack over it (ReDoS).
    if (/\s/u.test(source[i]) && /\s/u.test(normalized.at(-1) ?? '')) continue;
    const expanded = source[i].normalize('NFKC').toLowerCase();
    for (const char of expanded) {
      normalized += char;
      positions.push(i);
    }
  }
  // Repair mixed-script evasion only inside words containing Cyrillic letters.
  normalized = normalized.replace(/[\p{L}\p{N}@]+/gu, word => {
    if (!/[а-яёәіңғүұқөһ]/u.test(word)) return word;
    let repaired = word.replace(/[aceopxyki@]/gu, char => ({ a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', i: 'и', '@': 'а' })[char]);
    // Leetspeak digits inside a word ("к4з1н0"); a leading digit is a quantity ("500тг"). Length is preserved.
    if (/^\p{L}/u.test(repaired) && (repaired.match(/[а-яё]/gu)?.length ?? 0) >= 2) {
      repaired = repaired.replace(/(?<=\p{L})[01346]/gu, digit => ({ 0: 'о', 1: 'и', 3: 'з', 4: 'а', 6: 'б' })[digit]);
    }
    return repaired;
  });
  return { source, normalized, positions };
}

const unicodePatterns = new WeakMap();
function unicodeRegexOf(regex) {
  // JavaScript's \w remains ASCII even with /u; rules need Cyrillic suffixes.
  if (!unicodePatterns.has(regex)) {
    unicodePatterns.set(regex, new RegExp(regex.source.replaceAll('\\w', '[\\p{L}\\p{N}_]'), regex.flags));
  }
  return unicodePatterns.get(regex);
}
function toSourceMatch(match, context) {
  const start = context.positions[match.index] ?? 0;
  const last = context.positions[match.index + match[0].length - 1] ?? start;
  return { quote: context.source.slice(start, last + 1), index: start, captures: match.slice(1) };
}
function firstMatch(regex, context) {
  const unicodeRegex = unicodeRegexOf(regex);
  unicodeRegex.lastIndex = 0;
  const match = unicodeRegex.exec(context.normalized);
  return match ? toSourceMatch(match, context) : null;
}
function* matchesOf(regex, context, limit = 25) {
  const unicodeRegex = unicodeRegexOf(regex);
  unicodeRegex.lastIndex = 0;
  for (let count = 0; count < limit; count++) {
    const match = unicodeRegex.exec(context.normalized);
    if (!match) return;
    if (match[0] === '') unicodeRegex.lastIndex++;
    yield toSourceMatch(match, context);
  }
}

// A rule instance is skipped when the source itself negates it ("покупать билет не требуется", "без казино").
function isNegated(id, match, content) {
  const before = content.slice(Math.max(0, match.index - 32), match.index).toLowerCase();
  const after = content.slice(match.index + match.quote.length, match.index + match.quote.length + 28).toLowerCase();
  if (id === 'entry_payment' && /^билет/iu.test(match.quote)) {
    const around = content.slice(Math.max(0, match.index - 90), match.index + match.quote.length + 60);
    if (/концерт|спектакл|театр|кинотеатр|сеанс|матч|выставк|фестивал|шоу(?![\p{L}])|экскурс|дворец|филармони|стадион|арен[аеу]|мюзикл|стендап|концертн/iu.test(around)) return true;
  }
  if (['entry_payment', 'slot_purchase'].includes(id)) {
    return /(?:no|without(?:\s+an?)?|не\s+(?:нужно|нужен|требуется)|не\s+надо)\s*$/iu.test(before)
      || /^[^.!?\n]{0,12}(?:не\s+(?:требуется|нужно|нужен|надо|обязательн\p{L}*)|қажет\s+емес|not\s+required)/iu.test(after);
  }
  if (id === 'investment') return /(?:без|никаких|нет|не\s+нужно)\s*(?:\p{L}+\s+)?$/iu.test(before) || /^[^.!?\n]{0,6}(?:не\s+нужн\p{L}*|нет)/iu.test(after);
  if (id === 'casino_mention') return /(?:без|никак\p{L}*|нет)\s+(?:\p{L}+\s+(?:и\s+)?){0,2}$/iu.test(before);
  return false;
}

const SHORTENER = /(?:^|\/\/|\.|\s)(?:bit\.ly|clck\.ru|t\.ly|cutt\.ly|tinyurl\.com|goo\.su|is\.gd|shorturl\.at|rebrand\.ly|vk\.cc|u\.to|tiny\.cc)\//iu;
const REFERRAL_URL = /[?&](?:ref|aff|affid|affiliate|partner|pid|clickid|click_id|subid|sub_id|btag|promo|promocode)=|\/(?:ref|aff|promo)\/[\w-]+/iu;
const INVITE_URL = /(?:chat\.whatsapp\.com\/|wa\.me\/|t\.me\/\+|t\.me\/joinchat\/)/iu;
const GAMBLING_DOMAIN = /(?:^|[.-])(?:casino|kazino|kazik|slots?|bet|mirror|zerkalo|azart\w*|spin\w*|jackpot)(?:[.-]|\d|$)/iu;
const SPIN_BONUS = /\d+\s*fs(?![\p{L}])|фриспин|free\s*spins|бездеп|(?:бонус\w*|\+\s*\d+\s*%)\s+(?:к|на)\s+(?:первому\s+|первый\s+)?(?:депозит\w*|деп\w*|пополнени\w*)/iu;
// Mixed alphabets/digits inside one word, zero-width characters, spaced letters and slot emoji.
const MASKING = /(?<![\p{L}@])[\p{L}@]{0,40}(?:[а-яёәіңғүұқөһ][a-z@]|[a-z@][а-яёәіңғүұқөһ])[\p{L}@]{0,40}|(?<![\p{L}\p{N}])[а-яё]{1,}[0134@][а-яё]{1,}[\p{L}\p{N}]*|(?<!\p{L})\p{L}{1,40}[​-‍⁠﻿]\p{L}+|(?<![\p{L}])(?:\p{L}[\s.\-_*]){4,}\p{L}(?![\p{L}])|🎰/iu;

function extractTextUrls(source) {
  const rawUrls = source.match(/(?:https?:\/\/|www\.)[^\s<>"«»]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|kz|ru|io|me|app|xyz|top|click|site|online|win|bet|pro|vip|ly|cc|gd|su|example|casino|games|club|live|fun)(?:\/[^\s<>"«»]*)?/giu) ?? [];
  return rawUrls.map(value => value.replace(/[.,;:!?\)\]}]+$/gu, '')).filter(Boolean);
}

function extractEntities(source, suppliedUrl) {
  const rawUrls = extractTextUrls(source);
  if (suppliedUrl) rawUrls.unshift(String(suppliedUrl).trim());
  const urls = [...new Set(rawUrls.map(value => value.replace(/[.,;:!?\)\]}]+$/gu, '')).filter(Boolean))].slice(0, 30);
  const domains = [];
  for (const value of urls) {
    try {
      const parsed = new URL(/^[a-z]+:\/\//iu.test(value) ? value : `https://${value}`);
      if (['http:', 'https:'].includes(parsed.protocol)) domains.push(parsed.hostname.toLowerCase());
    } catch { /* Unparseable strings remain visible, never fetched. */ }
  }
  return {
    urls,
    domains: [...new Set(domains)],
    handles: [...new Set(source.match(/(?<![\p{L}\p{N}_.@])@[\p{L}\p{N}_.]{2,30}/gu) ?? [])].slice(0, 30),
    phones: [...new Set(source.match(/(?<!\d)(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu) ?? [])].slice(0, 30),
    emails: [...new Set((source.match(/(?<![\w.+-])[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}(?![\w.-])/giu) ?? []).map(value => value.toLowerCase()))].slice(0, 30),
    // Address-shaped indicators only: neither checksum nor wallet ownership is established.
    wallets: [...new Set(source.match(/(?<![a-zA-Z0-9])(?:0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{25,62})(?![a-zA-Z0-9])/g) ?? [])].slice(0, 30),
    // Card numbers are kept masked (first 4 + last 4) so evidence never stores a full PAN.
    cards: [...new Set((source.match(/(?<!\d)\d{4}(?:[\s-]?(?:\d{4}|\*{4})){2}[\s-]?\d{4}(?!\d)/gu) ?? []).map(value => {
      const digits = value.replace(/[^\d*]/gu, '');
      return `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
    }))].slice(0, 30),
    promoCodes: [...new Set([...source.matchAll(/(?:промо[-\s]?код\p{L}*|промо|promo\s*code|по\s+коду|bonus\s+code)\s*[:\-—«"']?\s*([A-Za-z0-9]{3,16})(?![\p{L}\p{N}])/giu)]
      .map(match => match[1]).filter(code => /[A-Z]/u.test(code) && /\d|^[A-Z]{3,}$/u.test(code)).map(code => code.toUpperCase()))].slice(0, 30),
    inviteLinks: urls.filter(value => INVITE_URL.test(value)).slice(0, 30),
    shortLinks: urls.filter(value => SHORTENER.test(` ${value}`)).slice(0, 30),
    referralLinks: urls.filter(value => REFERRAL_URL.test(value)).slice(0, 30),
  };
}

function languageOf(text) {
  const kk = /[әіңғүұқөһ]|\b(?:zh[ia]|qatysu|tabys|shaqyr|ushin)/iu.test(text);
  const ru = /[ёэщц]|(?:это|для|вам|свой|друзей|деньги|срочно|прибыль|доход|сегодня|играй|пришли)/iu.test(text);
  if (kk && ru) return 'mixed';
  if (kk) return 'kk';
  if (/[а-яё]/iu.test(text)) return 'ru';
  // Latin-script Russian/Kazakh is common in chats and evades Cyrillic keyword filters.
  return /\b(?:rozygr|razygr|utys|qatysu|tabys|salym|aqsha|kaspi|vlozh|poluch|nomer|bilet|kazino|dohod|garant|ostalos|priglasi|zhiber|audar)\w*/iu.test(text) ? 'translit' : 'unknown';
}

const trustedBrandDomains = ['kaspi.kz', 'halykbank.kz', 'halyk.kz', 'instagram.com', 'tiktok.com'];
const isDomainOrSubdomain = (domain, base) => domain === base || domain.endsWith(`.${base}`);

const AMOUNT = String.raw`((?:\d{1,3}(?:\s\d{3})+|\d+)(?:[.,]\d+)?)\s*(к|k|тыс\.?|тысяч\w*|мың|млн)?\s*(?:тг|тенге|теңге|₸|tg|tenge)?`;
// Ordered: the first two keep v4 quotes stable; later ones generalize wording, order and transliteration.
const MONEY_PROMISES = [
  { regex: /(?:влож\w*|внес\w*)\s+(\d{1,3}(?: \d{3})+|\d+)\s*(?:тг|тенге|₸)[^.!?\n]{0,30}?получи\w*\s+(\d{1,3}(?: \d{3})+|\d+)\s*(?:тг|тенге|₸)\s+(?:завтра|за\s+\d+\s+дн\w*|через\s+неделю)/giu, groups: 'plain' },
  { regex: /(\d{1,3}(?: \d{3})+|\d+)\s*(?:теңге|тг|₸)\s+сал[^.!?\n]{0,20}?(\d{1,3}(?: \d{3})+|\d+)\s*(?:теңге|тг|₸)\s+ал/giu, groups: 'plain' },
  { regex: new RegExp(String.raw`(?:влож\w*|вкладыва\w*|внес\w*|внёс\w*|закин\w*|закидыва\w*|инвестир\w*|отправля\w*|скидыва\w*|старт\w*|vlozh\w*|вход\w*\s+(?:с|от)|заходил\w*\s+с)\s*(?:[\p{L}]+\s+){0,2}(?:от\s+)?${AMOUNT}[^.!?\n]{0,70}?(?:получ\w*|выв(?:ел|ела|ели|оди\w*)|забир\w*|poluch\w*|верн\w*|переводят\s+тебе|на\s+выходе)\s*(?:уже\s+|ровно\s+|обратно\s+)?${AMOUNT}`, 'giu'), groups: 'suffixed' },
  { regex: new RegExp(String.raw`${AMOUNT}\s*(?:сал(?:саң\w*|ып|ыңыз|ың|асыз|сан\w*)?|sal\w*)(?![\p{L}])[^.!?\n]{0,60}?${AMOUNT}\s*(?:ал(?:асың|асыз|ыңыз|ып|дым|асыңдар)?|al\w*)(?![\p{L}])`, 'giu'), groups: 'suffixed' },
  { regex: new RegExp(String.raw`салым\w*\s*${AMOUNT}[^.!?\n]{0,60}?${AMOUNT}\s*ал\w*`, 'giu'), groups: 'suffixed' },
  { regex: new RegExp(String.raw`(?:вход\w*|кіру|взнос\w*|салым\w*|salym|ең\s+аз\s+салым)\s*(?:от\s+|[—–:-]\s*)?${AMOUNT}[^!?\n]{0,90}?(?:\d+\s*(?:-?й\s+)?(?:день|дн\w*|күн\w*|сағат\w*|sagat\w*|kun\w*)|недел\w*|апта\w*|[\p{L}]+\s+(?:аласың|аласыз|получа\w*))[^\d\n]{0,25}?${AMOUNT}`, 'giu'), groups: 'suffixed' },
  { regex: new RegExp(String.raw`(?:выплат\w*|получил\w*|пришл\w*|түсті|tusti)\s*[^.?\n\d]{0,20}?${AMOUNT}[^?\n]{0,60}?(?:заходил\w*|зашл\w*|вложил\w*|кіргенде|kirgende|салғам|salgam)\s*(?:с\s+)?(?:[\p{L}]+\s+)?${AMOUNT}`, 'giu'), groups: 'reversed' },
  { regex: new RegExp(String.raw`(?:дари\w*|отдаешь|отдаёшь)\s+${AMOUNT}[^!?\n]{0,90}?(?:получа\w*|получишь)\s+${AMOUNT}`, 'giu'), groups: 'suffixed' },
  { regex: new RegExp(String.raw`(?:из|с)\s+${AMOUNT}\s*(?:[—–-]|в|до)\s*${AMOUNT}`, 'giu'), groups: 'suffixed', needsInvestment: true },
  { regex: new RegExp(String.raw`${AMOUNT}\s*(?:→|->|=>|➡️?|⇒)\s*[^\d\n]{0,25}?${AMOUNT}`, 'giu'), groups: 'suffixed', needsInvestment: true },
];
const amountOf = (digits, suffix = '') => {
  const value = Number(String(digits ?? '').replace(/\s/gu, '').replace(',', '.'));
  if (!Number.isFinite(value)) return 0;
  if (/^(?:к|k|тыс|мың)/iu.test(suffix ?? '')) return value * 1000;
  if (/^млн/iu.test(suffix ?? '')) return value * 1e6;
  return value;
};

// Scheme elements mirror the hackathon brief's "what to look for" lists, so analysts see which parts are present.
const ELEMENTS = {
  lottery: [
    ['paid_entry', ['entry_payment', 'slot_purchase', 'kaspi_transfer', 'payment'], 'Платное участие', 'Ақылы қатысу'],
    ['random_selection', ['random_draw'], 'Случайный выбор победителя', 'Жеңімпазды кездейсоқ таңдау'],
    ['organizer_income', ['organizer_income'], 'Доход организатора', 'Ұйымдастырушы табысы'],
    ['repetition', ['series', 'network_link', 'account_series', 'known_indicator'], 'Повторяемость и связи', 'Қайталану және байланыстар'],
  ],
  casino: [
    ['gambling', ['casino_mention', 'gambling_action'], 'Азартная игра или игровая площадка', 'Құмар ойын не ойын алаңы'],
    ['redirect', ['bonus', 'deposit', 'mirror', 'proxy_redirect', 'referral_link', 'short_link', 'gambling_domain', 'known_indicator', 'network_link', 'link_casino', 'bio_link_casino'], 'Переход: ссылка, промокод, зеркало', 'Өту: сілтеме, промокод, айна'],
    ['native', ['native_win'], 'Нативная подача: «мой выигрыш», стрим, вывод', 'Жасырын жарнама: ұтыс, стрим, шығару'],
    ['masking', ['obfuscation'], 'Маскировка текста', 'Мәтінді бүркемелеу'],
  ],
  pyramid: [
    ['unrealistic_return', ['numeric_return', 'fast_returns', 'guaranteed_profit'], 'Нереалистичная доходность', 'Шынайы емес табыс'],
    ['pressure', ['urgency'], 'Давление и срочность', 'Қысым және асықтыру'],
    ['referral', ['recruitment', 'referral_link'], 'Реферальная модель', 'Рефералдық модель'],
    ['proof', ['payout_proof'], 'Подтверждения: выплаты, отзывы', 'Дәлелдер: төлемдер, пікірлер'],
    ['payment_channel', ['kaspi_transfer', 'payment'], 'Перевод на карту / Kaspi', 'Картаға / Kaspi-ге аудару'],
    ['structure', ['structure', 'curator', 'template_messages', 'group_roles', 'known_indicator', 'network_link'], 'Структура: кураторы, уровни', 'Құрылым: кураторлар, деңгейлер'],
  ],
};
const TRACKS = { lottery: 1, casino: 2, pyramid: 3 };

export function schemeElements(category, signals) {
  return (ELEMENTS[category] ?? []).map(([id, ids, ru, kk]) => {
    const evidence = signals.filter(signal => ids.includes(signal.id) && [category, 'network'].includes(signal.category));
    return { id, label: { ru, kk }, present: evidence.length > 0, evidence: evidence.map(signal => signal.quote).filter(Boolean).slice(0, 3) };
  });
}

export function analyzeContent({ text = '', url = '', platform = 'other' } = {}) {
  const content = String(text ?? '').slice(0, 30000);
  const suppliedUrl = String(url ?? '').slice(0, 2048).trim();
  const context = normalizeWithMap(content);
  const entities = extractEntities(content, suppliedUrl);
  // Preserve source provenance in entities, but only caption URLs are link evidence.
  const captionUrls = extractTextUrls(content);
  const hits = new Map();
  for (const [id, category, weight, label, description, regex] of RULES) {
    for (const match of matchesOf(regex, context)) {
      if (isNegated(id, match, content)) continue;
      hits.set(id, { id, category, weight, label, description, quote: match.quote });
      break;
    }
  }
  const has = id => hits.has(id);
  // Compare promised principal/payout instead of assuming every pair of prices is a return.
  for (const { regex, groups, needsInvestment } of MONEY_PROMISES) {
    if (needsInvestment && !has('investment') && !has('urgency')) continue;
    for (const match of matchesOf(regex, context, 10)) {
      const [principal, payout] = groups === 'plain'
        ? match.captures.map(value => Number(value.replaceAll(' ', '')))
        : groups === 'reversed'
          ? [amountOf(match.captures[2], match.captures[3]), amountOf(match.captures[0], match.captures[1])]
          : [amountOf(match.captures[0], match.captures[1]), amountOf(match.captures[2], match.captures[3])];
      if (principal >= 500 && payout >= principal * 1.5 && payout <= principal * 20) {
        hits.set('numeric_return', { id: 'numeric_return', category: 'pyramid', weight: 32,
          label: 'Салымды жылдам көбейту уәдесі',
          description: 'Ақша салғаннан кейін кемінде 1,5 есе көп ақша алу ұсынылады. Бұл орындалатыны тексерілген жоқ.',
          quote: match.quote });
        break;
      }
    }
    if (has('numeric_return')) break;
  }
  const referralUrl = captionUrls.find(value => REFERRAL_URL.test(value));
  const shortUrl = captionUrls.find(value => SHORTENER.test(` ${value}`));
  const warnings = firstMatch(WARNING, context);
  const report = firstMatch(REPORT, context);
  const quotedWarning = firstMatch(QUOTED_WARNING, context);
  const promotionalLink = firstMatch(PROMO_LINK, context);
  const freeEntry = firstMatch(FREE_ENTRY, context);

  // Track 1: paid entry + draw. Free contests (subscribe/like/repost) never qualify without an explicit payment.
  const drawContext = has('giveaway') || has('random_draw');
  const hasLottery = (has('entry_payment') && (drawContext || has('organizer_income')))
    || (has('slot_purchase') && (drawContext || has('organizer_income') || has('kaspi_transfer') || has('payment') || has('entry_payment')))
    || (!freeEntry && has('giveaway') && has('organizer_income') && (has('kaspi_transfer') || has('payment')));
  // Track 2: explicit gambling words, or hidden promotion (personal wins + a route to the site, or a mirror).
  let casinoMention = has('casino_mention');
  if (casinoMention && hasLottery && /^(?:слот|slot)/iu.test(hits.get('casino_mention').quote)) casinoMention = false;
  const redirect = has('bonus') || has('deposit') || has('mirror') || has('proxy_redirect') || Boolean(promotionalLink || referralUrl || shortUrl) || captionUrls.length > 0;
  const routed = entities.promoCodes.length > 0 || Boolean(referralUrl || shortUrl || promotionalLink) || has('proxy_redirect');
  const gamblingDomain = captionUrls.find(value => GAMBLING_DOMAIN.test(value.replace(/^https?:\/\//iu, '').split(/[/?#]/u)[0]));
  // Deposit bonuses, free spins and gambling-named domains are casino-specific even when the word "casino" is avoided.
  const hasCasino = casinoMention || has('mirror') || (has('native_win') && redirect)
    || (has('deposit') && has('bonus') && routed)
    || (Boolean(referralUrl) && (SPIN_BONUS.test(context.normalized) || has('deposit')))
    || (Boolean(gamblingDomain) && (has('bonus') || has('native_win') || has('deposit')));
  // Track 3: unrealistic return, recruitment, proofs and curators in combination.
  const returnPromise = has('guaranteed_profit') || has('fast_returns') || has('numeric_return');
  const hasPyramid = (has('guaranteed_profit') && (has('investment') || has('fast_returns') || has('recruitment')))
    || (has('recruitment') && (has('investment') || has('fast_returns') || has('structure') || has('numeric_return') || has('curator')))
    || (has('fast_returns') && (has('investment') || has('kaspi_transfer') || has('curator') || has('payout_proof')))
    || has('numeric_return') || (has('structure') && (returnPromise || has('recruitment') || has('curator') || has('payout_proof') || has('kaspi_transfer') || has('payment')))
    || (has('payout_proof') && (returnPromise || has('investment') || has('recruitment') || has('curator') || has('kaspi_transfer') || has('urgency')))
    || (has('curator') && (returnPromise || (has('investment') && has('kaspi_transfer'))));

  // Context changes interpretation, but never asserts the content is safe.
  const prevention = Boolean(quotedWarning || report || warnings);
  const directAction = prevention ? directActionOutsideReport(content) : null;
  const riskOffer = casinoMention || has('mirror') || (has('native_win') && hasCasino) || returnPromise || has('sensitive_request') || hasLottery;
  const mixedContext = Boolean(prevention && directAction && riskOffer);
  const riskContext = mixedContext ? 'mixed_requires_review' : prevention ? 'warning_or_news' : 'offer_or_unknown';
  const contextFactor = prevention && !mixedContext ? 0.12 : 1;
  const categories = Object.fromEntries(Object.keys(CATEGORY_LABELS).map(id => [id, 0]));
  const signals = [];

  function add(id, category = null, factor = 1) {
    const hit = hits.get(id);
    if (!hit) return;
    const target = category ?? hit.category;
    const weight = Math.round(hit.weight * contextFactor * factor);
    if (signals.some(signal => signal.id === id && signal.category === target)) return;
    categories[target] += weight;
    signals.push({ ...hit, category: target, weight });
  }
  function addCustom(id, category, weight, label, description, quote) {
    if (signals.some(signal => signal.id === id && signal.category === category)) return;
    const adjustedWeight = Math.round(weight * contextFactor);
    categories[category] += adjustedWeight;
    signals.push({ id, category, weight: adjustedWeight, label, description, quote });
  }

  if (hasLottery) {
    add('giveaway');
    // Ticket and slot wording often co-occur; the second describes the same payment and adds little.
    if (has('entry_payment')) { add('entry_payment'); add('slot_purchase', null, 0.24); } else add('slot_purchase');
    add('random_draw');
    add('organizer_income');
    add('series');
    add('urgency', 'lottery');
    add('payment', 'lottery');
    add('kaspi_transfer', 'lottery');
  }

  if (hasCasino) {
    const promotion = has('gambling_action') || has('bonus') || has('deposit') || promotionalLink || has('native_win') || has('mirror') || has('proxy_redirect') || referralUrl || shortUrl;
    if (casinoMention) add('casino_mention', 'casino', promotion ? 1 : 0.45);
    add('gambling_action');
    add('bonus');
    add('deposit');
    add('native_win');
    add('mirror');
    add('proxy_redirect');
    if (promotion) add('urgency', 'casino');
    if (referralUrl) addCustom('referral_link', 'casino', 12, 'Рефералдық не трекинг сілтеме', 'Сілтемеде серіктес/реферал параметрі бар (ref, aff, subid): жарнама берушіге өтуді санайтын механизм.', referralUrl);
    if (shortUrl) addCustom('short_link', 'casino', 8, 'Қысқартылған сілтеме', 'Сілтеме қысқартқыш арқылы берілген, соңғы мекенжай жасырын. Сілтеме ашылмады.', shortUrl);
    if (gamblingDomain) addCustom('gambling_domain', 'casino', 12, 'Ойын сөздері бар домен', 'Домен атауында ойын/айна сөздері бар (casino, mirror, spin, azart, bet). Сайт ашылмады, лицензия тексерілмеді.', gamblingDomain);
  }

  if (hasPyramid) {
    for (const id of ['investment', 'guaranteed_profit', 'fast_returns', 'numeric_return', 'recruitment', 'structure', 'curator', 'payout_proof']) add(id);
    add('urgency', 'pyramid');
    add('payment', 'pyramid');
    add('kaspi_transfer', 'pyramid');
    if (referralUrl) addCustom('referral_link', 'pyramid', 8, 'Рефералдық сілтеме', 'Шақыру сілтемесінде реферал параметрі бар: жаңа қатысушыны кім әкелгені есептеледі.', referralUrl);
  }

  const suspiciousDomains = entities.domains.filter(domain => {
    const brand = /kaspi|каспи|halyk|instagram|tiktok/iu.test(domain);
    return brand && !trustedBrandDomains.some(base => isDomainOrSubdomain(domain, base));
  });
  const hasPhishing = has('sensitive_request') || has('login_request') || has('account_threat') || suspiciousDomains.length > 0;
  if (hasPhishing) {
    for (const id of ['sensitive_request', 'account_threat', 'login_request', 'impersonation']) add(id);
    add('urgency', 'phishing');
    if (suspiciousDomains.length) {
      const domain = suspiciousDomains[0];
      addCustom('brand_domain', 'phishing', 26, 'Брендке ұқсас домен',
        'Доменде танымал бренд атауы бар, бірақ ол қолданбадағы шағын ресми домендер тізімімен сәйкес келмейді. Бұл тек мәтіндік белгі, репутация тексерілген жоқ.',
        entities.urls.find(value => value.toLowerCase().includes(domain)) ?? domain);
    }
  }

  for (const category of Object.keys(categories)) {
    const relevant = category === 'lottery' ? hasLottery : category === 'casino' ? hasCasino && categories.casino > 20 : category === 'pyramid' ? hasPyramid : hasPhishing;
    if (relevant && captionUrls.length) {
      addCustom(`link_${category}`, category, category === 'phishing' ? 12 : 7,
        'Сыртқы сілтеме', 'Сілтеме басқа тәуекел белгілерімен бірге кездеседі. Сілтеменің өзі алаяқтықтың дәлелі емес.', captionUrls[0]);
    } else if (relevant && promotionalLink) {
      addCustom(`bio_link_${category}`, category, 6, 'Профильдегі сілтемеге бағыттау', 'Мәтін профильдегі сілтемеге өтуді ұсынады.', promotionalLink.quote);
    }
  }

  // Masking only matters when a scheme already matched; mixed alphabets alone are ordinary in KZ chats.
  const masking = (hasCasino || hasLottery || hasPyramid) ? MASKING.exec(content) : null;
  if (masking) {
    const target = ['casino', 'lottery', 'pyramid'].filter(id => (id === 'casino' ? hasCasino : id === 'lottery' ? hasLottery : hasPyramid)).sort((a, b) => categories[b] - categories[a])[0];
    addCustom('obfuscation', target, 8, 'Мәтінді бүркемелеу', 'Сөз ішінде әліпбилер не цифрлар араласқан, әріптер бөлінген не көрінбейтін таңба/эмодзи бар — сүзгіден жасыру тәсілі болуы мүмкін.', masking[0]);
  }

  if (mixedContext) {
    signals.push({id:'mixed_context',category:'context',weight:0,
      label:'Ескерту мен шақыру қатар кездеседі',
      description:'Мәтінде ескерту де, дәйексөзден тыс тікелей шақыру да бар. Ескерту сөзі тәуекел балын төмендетпейді; мағынасын адам тексеруі қажет.',quote:directAction.quote});
  } else if (prevention && signals.length) {
    const match = quotedWarning || report || warnings;
    signals.push({ id: 'prevention_context', category: 'context', weight: 0,
      label: 'Ескерту немесе ақпараттық контекст',
      description: 'Мәтінде сақтандыру, терістеу немесе жаңалық белгілері бар: балл төмендетілді. Ұзын аралас мәтінде мағынаны адам тексеруі керек.', quote: match.quote });
  }
  if (freeEntry && has('giveaway') && !hasLottery) {
    signals.push({ id: 'free_entry_context', category: 'context', weight: 0,
      label: 'Тегін байқау белгілері',
      description: 'Қатысу тегін екені не жазылу/лайк шарттары көрсетілген, ақылы қатысу табылмады. Бұл заңды байқауға ұқсайды.', quote: freeEntry.quote });
  }
  const categoryList = Object.entries(categories).map(([id, score]) => ({ id, label: CATEGORY_LABELS[id], score: Math.min(100, Math.max(0, Math.round(score))) })).sort((a, b) => b.score - a.score);
  const score = categoryList[0]?.score ?? 0;
  const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  const category = score >= 25 ? categoryList[0].id : 'none';
  const summary = mixedContext
    ? 'Ескерту мен тәуекелді ұсынысқа шақыру қатар кездеседі. Бұл аралас мәтінді адам тексеруі керек; ескерту сөзі балды төмендеткен жоқ.'
    : level === 'high'
    ? 'Бірнеше айқын тәуекел белгісі табылды. Ақша не құпия дерек жібермей, ұсынысты тәуелсіз тексеріңіз.'
    : level === 'medium'
      ? 'Күмән тудыратын белгілер бар. Ұсыныстың мәнін және дереккөзін қосымша тексеру керек.'
      : prevention && signals.length
        ? 'Мәтін ескертуге немесе ақпараттық хабарға ұқсайды. Контекст ескеріліп, тәуекел балы төмендетілді.'
        : 'Таңдалған ережелер бойынша айқын тәуекел белгілері аз. Бұл қауіпсіздік кепілдігі емес.';
  const sortedSignals = signals.sort((a, b) => b.weight - a.weight);
  const analysis = {
    score, level, category, track: TRACKS[category] ?? null, categories: categoryList, riskContext, riskContextMethod:'rules',
    riskContextBasis:[...(prevention?[{kind:'warning_or_report',quote:(quotedWarning || report || warnings).quote}]:[]),...(mixedContext?[{kind:'direct_call_to_action',quote:directAction.quote}]:[])],
    signals: sortedSignals, elements: schemeElements(category, sortedSignals), entities,
    // Raw rule matches before combination logic: lets group analysis see partial evidence in single messages.
    matchedRules: [...hits.keys()],
    language: languageOf(content), summary,
    limitations: [
      'Нәтиже — түсіндірілетін ережелерге негізделген алдын ала скрининг; алаяқтық туралы түпкілікті үкім емес.',
      'Сілтемелер ашылмайды: доменнің репутациясы, аккаунт иесі, лицензия және төлем тарихы тексерілген жоқ.',
      'Сурет, видео, жабық хат алмасу және парақша мазмұны мәтінсіз талданбайды; жаңа сленг пен контекст қателікке әкелуі мүмкін.',
      ...(content.length === 30000 ? ['Талдау алғашқы 30 000 таңбамен шектелді.'] : []),
    ],
  };
  analysis.translations = buildTranslations(analysis);
  return analysis;
}

/** Adds bounded extra signals (network, model) and recomputes score, level, category, track and elements. */
export function applyExtraSignals(analysis, extraSignals) {
  if (!extraSignals.length) return analysis;
  const signals = [...analysis.signals.filter(signal => !extraSignals.some(extra => extra.id === signal.id)), ...extraSignals.map(({ labelRu, descriptionRu, ...signal }) => signal)];
  const totals = Object.fromEntries((analysis.categories ?? []).map(item => [item.id, 0]));
  for (const signal of signals) if (signal.category in totals) totals[signal.category] += signal.weight;
  const categories = (analysis.categories ?? []).map(item => ({ ...item, score: Math.min(100, Math.max(0, Math.round(totals[item.id]))) })).sort((a, b) => b.score - a.score);
  const score = categories[0]?.score ?? 0;
  const category = score >= 25 ? categories[0].id : 'none';
  const sorted = signals.sort((a, b) => b.weight - a.weight);
  const merge = (locale, label, description) => ({ ...analysis.translations?.[locale], signals: [...(analysis.translations?.[locale]?.signals ?? []).filter(signal => !extraSignals.some(extra => extra.id === signal.id)), ...extraSignals.map(signal => ({ id: signal.id, label: signal[label] ?? signal.label, description: signal[description] ?? signal.description }))] });
  return { ...analysis, categories, score, level: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low', category, track: TRACKS[category] ?? null, signals: sorted, elements: schemeElements(category, sorted),
    ...(analysis.translations ? { translations: { ru: merge('ru', 'labelRu', 'descriptionRu'), kk: merge('kk', 'label', 'description') } } : {}) };
}

/** Hybrid screening: rules first; the n-gram model may add one explained signal when the rules found too little. */
export function screenContent(input = {}, base = analyzeContent(input)) {
  const model = loadModel();
  if (!model) return base;
  const prediction = predict(model, String(input.text ?? ''));
  const threshold = model.hybridThreshold ?? 0.5;
  const withModel = { ...base, model: { ...prediction, probability: Number(prediction.probability.toFixed(4)), threshold, version: model.meta?.trainedAt ?? null } };
  if (base.score >= 30 || prediction.label === 'none' || prediction.probability < threshold || base.riskContext === 'warning_or_news') return withModel;
  const weight = 30 + Math.round(((prediction.probability - threshold) / (1 - threshold)) * 15);
  const terms = prediction.topTerms.slice(0, 4);
  const percent = Math.round(prediction.probability * 100);
  return applyExtraSignals(withModel, [{ id: 'ml_model', category: prediction.label, weight, quote: terms[0] ?? '',
    label: 'Статистикалық модельдің бағасы', description: `N-грам моделі мәтінді «${prediction.label}» мысалдарына ұқсас деп бағалады (${percent}%). Әсер еткен сөздер: ${terms.join(', ') || '—'}. Ережелер аз белгі тапты — адам тексеруі керек.`,
    labelRu: 'Оценка статистической модели', descriptionRu: `N-граммная модель сочла текст похожим на примеры класса «${prediction.label}» (${percent}%). Повлиявшие слова: ${terms.join(', ') || '—'}. Правила нашли мало признаков — нужна проверка человеком.` }]);
}

const MODALITY_PARTS = ['text', 'ocrText', 'transcript'];
/** Multimodal item: caption, OCR of screenshots and stream transcripts are scored together; each quote keeps its source. */
export function analyzeItem({ text = '', ocrText = '', transcript = '', url = '', platform = 'other' } = {}) {
  const values = { text, ocrText, transcript };
  const parts = MODALITY_PARTS.map(key => [key, String(values[key] ?? '').trim()]).filter(([, value]) => value);
  // A warning caption over a screenshot of a scam ("Пример мошеннического сообщения 👇") shows the scam as a quote.
  const caption = parts.find(([key]) => key === 'text')?.[1] ?? '';
  const quoteMedia = parts.length > 1 && caption && analyzeContent({ text: caption }).riskContext === 'warning_or_news';
  const shown = parts.map(([key, value]) => [key, quoteMedia && key !== 'text' ? `«${value.replaceAll('«', '“').replaceAll('»', '”')}»` : value]);
  const combined = shown.map(([, value]) => value).join('\n\n');
  const analysis = screenContent({ text: combined, url, platform });
  const ranges = [];
  let offset = 0;
  for (const [key, value] of shown) { ranges.push([key, offset, offset + value.length]); offset += value.length + 2; }
  const modalityOf = quote => {
    if (!quote) return null;
    const index = combined.indexOf(quote);
    return ranges.find(([, start, end]) => index >= start && index < end)?.[0] ?? null;
  };
  analysis.signals = analysis.signals.map(signal => ({ ...signal, modality: modalityOf(signal.quote) }));
  analysis.modalities = parts.map(([key]) => key);
  return analysis;
}

const RUSSIAN_SIGNALS = {
  giveaway: ['Предложение розыгрыша', 'В тексте упоминается розыгрыш, лотерея или случайный выбор победителя.'],
  entry_payment: ['Плата за участие', 'Участие в розыгрыше связано с покупкой билета, номера, слота или внесением платы.'],
  casino_mention: ['Упоминание азартных игр', 'Найдены слова, связанные с казино, букмекером, слотами или ставками.'],
  gambling_action: ['Призыв к азартной игре', 'Есть призыв играть, делать ставки или зарегистрироваться на игровой площадке.'],
  bonus: ['Привлечение бонусом', 'Бонус, промокод или бесплатные вращения могут использоваться для привлечения к игре.'],
  deposit: ['Пополнение игрового счёта', 'Предлагается внести деньги или пополнить депозит.'],
  investment: ['Инвестиционное предложение', 'В тексте есть предложение вложить деньги, инвестировать или получать доход.'],
  guaranteed_profit: ['Обещание гарантированного дохода', 'Обещание дохода без риска или с гарантией требует независимой проверки.'],
  fast_returns: ['Быстрый высокий доход', 'Указаны высокие проценты за день или неделю либо обещание быстро приумножить деньги.'],
  numeric_return: ['Обещание приумножить вклад', 'После внесения денег предлагается получить как минимум в 1,5 раза больше. Выполнимость обещания не проверена.'],
  recruitment: ['Вознаграждение за новых участников', 'Привлечение новых людей может быть связано с доходом или уровнем в структуре.'],
  structure: ['Сетевая денежная структура', 'Есть упоминания матрицы, нижних уровней или выплат за счёт вкладов новых участников.'],
  sensitive_request: ['Запрос секретного кода или данных', 'Просят отправить другому человеку SMS/OTP-код, пароль или секретные данные карты.'],
  account_threat: ['Угроза блокировки аккаунта', 'Сообщение создаёт давление угрозой блокировки или потери доступа.'],
  login_request: ['Подтверждение через ссылку', 'Просят подтвердить аккаунт, личность или банковские данные через ссылку.'],
  impersonation: ['Упоминание банка или поддержки', 'Название банка или службы поддержки встречается вместе с другими подозрительными признаками.'],
  urgency: ['Давление срочностью', 'Ограниченное время или призыв торопиться подталкивает к быстрому решению.'],
  payment: ['Призыв перевести деньги', 'Просят перевести деньги, внести взнос или выполнить платёж.'],
  brand_domain: ['Домен похож на известный бренд', 'Домен содержит название известного бренда, но не совпадает с небольшим списком официальных доменов в приложении. Это только текстовый признак: репутация не проверялась.'],
  external_link: ['Внешняя ссылка', 'Ссылка встречается вместе с другими признаками риска. Сама по себе ссылка не доказывает мошенничество.'],
  bio_link: ['Переход по ссылке в профиле', 'Текст предлагает перейти по ссылке в профиле.'],
  slot_purchase: ['Продажа номеров или слотов', 'Номера, слоты или места в розыгрыше продаются по указанной цене.'],
  random_draw: ['Случайный выбор победителя', 'Победителя определяют рандомайзером, колесом, барабаном или жеребьёвкой в эфире.'],
  organizer_income: ['Доход организатора', 'Количество проданных номеров и слотов или собранная сумма показывают, что организатор собирает деньги.'],
  series: ['Серия розыгрышей', 'Розыгрыши проводятся регулярно: нумерация, «каждую неделю», «новый розыгрыш».'],
  native_win: ['Нативная реклама: «мой выигрыш»', 'Личный рассказ о выигрыше, выводе денег или «заносе» может быть скрытой рекламой игровой площадки.'],
  mirror: ['Зеркало сайта', 'Предлагается «рабочее зеркало» или новый адрес для обхода блокировки сайта.'],
  proxy_redirect: ['Переход через посредника', 'Ссылку не дают напрямую: отправляют в закреп, описание, шапку профиля или личные сообщения.'],
  curator: ['Кураторы и лидеры', 'Деньги принимают «куратор», «наставник» или «лидер» — признак иерархии в группе.'],
  payout_proof: ['«Подтверждения» выплат и отзывы', 'Скриншоты выплат и отзывы «всё честно» могут использоваться для «прогрева» новых участников.'],
  kaspi_transfer: ['Перевод на личную карту / Kaspi', 'Просят перевести деньги через Kaspi или на личную карту, а не через официальный платёж организации.'],
  referral_link: ['Реферальная или трекинговая ссылка', 'В ссылке есть партнёрский параметр (ref, aff, subid): механизм учёта переходов к рекламодателю или привлечённых участников.'],
  gambling_domain: ['Домен с игровыми словами', 'В имени домена есть игровые слова или «зеркало» (casino, mirror, spin, azart, bet). Сайт не открывался, лицензия не проверялась.'],
  known_indicator: ['Индикатор уже встречался в помеченных материалах', 'Промокод, ссылка, домен или реквизиты уже были в нескольких материалах, отправленных на проверку. Это связь, а не доказательство.'],
  group_roles: ['Структура ролей в группе', 'Организатор публикует предложения и реквизиты, кураторы повторяют призывы.'],
  short_link: ['Сокращённая ссылка', 'Ссылка дана через сокращатель, конечный адрес скрыт. Ссылка не открывалась.'],
  obfuscation: ['Маскировка текста', 'Внутри слова смешаны алфавиты или цифры, буквы разделены, есть невидимые символы или эмодзи — возможная попытка обойти фильтры.'],
  network_link: ['Связь с сетью аккаунтов', 'Совпадающие реквизиты, промокоды, ссылки или шаблоны связывают аккаунт с другими помеченными. Совпадение не доказывает общего владельца.'],
  account_series: ['Повторяющиеся публикации аккаунта', 'Аккаунт публикует несколько похожих рискованных материалов. Это повышает приоритет проверки.'],
  template_messages: ['Шаблонные сообщения', 'Разные участники группы публикуют почти одинаковые тексты — признак скоординированного «прогрева».'],
  free_entry_context: ['Признаки бесплатного конкурса', 'Указано бесплатное участие или условия «подписка/лайк/репост», платного участия не найдено. Похоже на обычный конкурс.'],
  prevention_context: ['Предупреждение или информационный контекст', 'Обнаружены признаки предупреждения, отрицания или новости: балл снижен. Смысл длинного смешанного сообщения должен проверить человек.'],
  mixed_context: ['Предупреждение вместе с прямым призывом', 'В тексте есть предупреждение и прямой призыв вне цитаты. Слово-предупреждение не снижает балл риска; смысл должен проверить человек.'],
};

function buildTranslations(analysis) {
  const warningContext = analysis.signals.some(signal => signal.id === 'prevention_context');
  const russianSummary = analysis.riskContext === 'mixed_requires_review'
    ? 'Предупреждение сочетается с призывом к рискованному предложению. Смешанный контекст должен проверить человек; слово-предупреждение не снизило балл.'
    : analysis.level === 'high'
    ? 'Обнаружено несколько выраженных признаков риска. Не отправляйте деньги или секретные данные до независимой проверки предложения.'
    : analysis.level === 'medium'
      ? 'Есть подозрительные признаки. Содержание предложения и его источник требуют дополнительной проверки.'
      : warningContext
        ? 'Текст похож на предупреждение или информационное сообщение. С учётом контекста балл риска снижен.'
        : 'По используемым правилам явных признаков риска мало. Это не гарантирует безопасность.';
  return {
    kk: {
      summary: analysis.summary,
      limitations: [...analysis.limitations],
      signals: analysis.signals.map(({ id, label, description }) => ({ id, label, description })),
    },
    ru: {
      summary: russianSummary,
      limitations: [
        'Результат — предварительный скрининг по объяснимым правилам, а не окончательный вывод о мошенничестве.',
        'Ссылки не открываются: репутация домена, владелец аккаунта, лицензия и история платежей не проверялись.',
        'Изображения, видео, закрытая переписка и содержимое страницы без переданного текста не анализируются; новый сленг и контекст могут привести к ошибкам.',
        ...(analysis.limitations.length > 3 ? ['Анализ ограничен первыми 30 000 символами.'] : []),
      ],
      signals: analysis.signals.map(signal => {
        const key = signal.id.startsWith('bio_link_') ? 'bio_link' : signal.id.startsWith('link_') ? 'external_link' : signal.id;
        const [label, description] = RUSSIAN_SIGNALS[key] ?? ['Дополнительный признак риска', 'Обнаружен дополнительный признак, который требует проверки в контексте исходного сообщения.'];
        return { id: signal.id, label, description };
      }),
    },
  };
}

/** Choose UI language without translating source evidence or changing detection. */
export function localizeAnalysis(analysis, locale = 'kk') {
  const localized = analysis.translations?.[locale === 'ru' ? 'ru' : 'kk'];
  if (!localized) return analysis;
  const signalText = new Map(localized.signals.map(signal => [signal.id, signal]));
  return {
    ...analysis,
    summary: localized.summary,
    limitations: [...localized.limitations],
    signals: analysis.signals.map(signal => {
      const translation = signalText.get(signal.id);
      return translation ? { ...signal, label: translation.label, description: translation.description } : { ...signal };
    }),
  };
}
