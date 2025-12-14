import { config } from 'dotenv';
config();

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HAS_PERPLEXITY = Boolean(PERPLEXITY_API_KEY);
const HAS_OPENAI = Boolean(OPENAI_API_KEY);
// Переменная для выбора провайдера: 'openai', 'perplexity', или 'both' (для сравнения)
// По умолчанию: OpenAI если доступен, иначе Perplexity
const AI_PROVIDER = process.env.AI_PROVIDER || (HAS_OPENAI ? 'openai' : 'perplexity');

const FETCH_TIMEOUT_MS = 6000;
const TARGET_WORDS_PER_SLIDE = 27; // Строго 27 слов для одинаковой скорости начитки (в диапазоне 25-30)
const AI_RETRIES = 2;

function capitalizeFirst(str: string) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function normalizeBlock(raw: string, targetWords: number = TARGET_WORDS_PER_SLIDE): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/).filter(Boolean);
  
  // Если слов больше целевого количества - обрезаем
  // Если меньше - оставляем как есть (AI должен генерировать правильное количество)
  const finalWords = words.length > targetWords 
    ? words.slice(0, targetWords)
    : words;
  
  let sentence = finalWords.join(' ');
  if (!/[.!?…]$/.test(sentence)) {
    sentence = sentence + '.';
  }
  return capitalizeFirst(sentence);
}

/**
 * Выравнивает количество слов во всех слайдах до одинакового значения
 */
function equalizeWordCount(blocks: string[]): string[] {
  if (blocks.length !== 3) return blocks;
  
  const wordCounts = blocks.map(b => b.split(/\s+/).filter(Boolean).length);
  const avgWords = Math.round(wordCounts.reduce((a, b) => a + b, 0) / 3);
  const targetWords = Math.max(TARGET_WORDS_PER_SLIDE, avgWords);
  
  return blocks.map((block, index) => {
    const words = block.split(/\s+/).filter(Boolean);
    const currentCount = words.length;
    
    if (currentCount === targetWords) {
      return block;
    }
    
    if (currentCount > targetWords) {
      // Обрезаем до целевого количества
      return words.slice(0, targetWords).join(' ') + (block.match(/[.!?…]$/) ? '' : '.');
    } else {
      // Если меньше - оставляем как есть (не добавляем слова, чтобы не искажать смысл)
      return block;
    }
  });
}

async function fetchWithTimeout(url: string, opts: any, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function tryParseArray(raw: string): string[] | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  
  // Убираем обёртки ```json ... ``` или ``` ... ```
  const codeFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch) {
    cleaned = codeFenceMatch[1].trim();
  }
  
  // Убираем возможные префиксы типа "Вот результат:" или "Ответ:"
  cleaned = cleaned.replace(/^(?:Вот|Ответ|Результат|JSON)[:\s]*/i, '');
  
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      // Фильтруем пустые строки и берем первые 3 непустых элемента
      const filtered = parsed.filter(s => s && typeof s === 'string' && s.trim().length > 0);
      if (filtered.length >= 3) return filtered.slice(0, 3);
      if (filtered.length > 0) return filtered; // Если меньше 3, но есть хотя бы один
    }
  } catch {
    // fallback: попробовать найти массив в тексте
    const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(s => s && typeof s === 'string' && s.trim().length > 0);
          if (filtered.length >= 3) return filtered.slice(0, 3);
        }
      } catch {}
    }
    
    // fallback: попробовать разбить по переводам строк или точкам
    const parts = cleaned
      .split(/\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 10); // Минимум 10 символов для валидного абзаца
    if (parts.length >= 3) return parts.slice(0, 3);
    
    const dotParts = cleaned
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
    if (dotParts.length >= 3) return dotParts.slice(0, 3);
  }
  return null;
}

async function tryPerplexity(text: string): Promise<string[] | null> {
  if (!HAS_PERPLEXITY) {
    console.warn('AI: PERPLEXITY_API_KEY отсутствует, используем фолбэк.');
    return null;
  }

  try {
    for (let attempt = 1; attempt <= AI_RETRIES; attempt++) {
      try {
        console.log(`AI: Perplexity call attempt ${attempt}`);
        const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            model: 'sonar-pro',
            max_tokens: 800,
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: `Ты профессиональный редактор новостных тикеров. Переписывай исходный текст в РОВНО 3 коротких новостных заголовка для бегущей строки.

ПРАВИЛА:
1. Сохраняй ВСЕ факты: даты, места, числа, имена
2. НЕ добавляй информацию, которой нет в исходном тексте
3. НЕ добавляй эмоции, оценки, метафоры - только факты
4. Каждый заголовок: 20-25 слов, законченная мысль
5. Хронологический порядок: начало → развитие → итоги

ФОРМАТ ОТВЕТА: Только JSON-массив из 3 строк, без пояснений:
["первый заголовок", "второй заголовок", "третий заголовок"]

ПРИМЕРЫ ХОРОШИХ ЗАГОЛОВКОВ:
- "Масштабные наводнения охватывают запад штата Вашингтон, уровень воды в реке Снохомиш достиг критической отметки."
- "Спасательные службы эвакуируют жителей из затопленных районов, закрыты основные автомагистрали."
- "Метеорологи прогнозируют продолжение ливней, уровень воды может подняться ещё на 2 метра."`
              },
              { role: 'user', content: `Перепиши этот текст в 3 новостных заголовка (20-25 слов каждый):\n\n${text}` }
            ]
          })
        });

        if (!response.ok) {
          console.error('Perplexity HTTP error', response.status, await response.text());
          continue;
        }

        const data: any = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content?.trim();
        console.log(`Perplexity raw content (attempt ${attempt}):`, rawContent?.slice(0, 200));

        const parsedArr = tryParseArray(rawContent || '');
        if (!parsedArr) continue;
        const normalized = parsedArr.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
        const equalized = equalizeWordCount(normalized);
        return equalized;
      } catch (err) {
        console.error(`Perplexity attempt ${attempt} error`, err);
        if (attempt === AI_RETRIES) throw err;
      }
    }
    return null;
  } catch (err) {
    console.error('Perplexity error', err);
    return null;
  }
}

async function tryOpenAI(text: string): Promise<string[] | null> {
  if (!HAS_OPENAI) {
    return null;
  }

  try {
    console.log('AI: OpenAI GPT call');
    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Быстрая и дешёвая модель
        max_tokens: 400,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `Ты профессиональный редактор новостных тикеров. Переписывай исходный текст в РОВНО 3 новостных заголовка для бегущей строки.

КРИТИЧЕСКИ ВАЖНО - КОЛИЧЕСТВО СЛОВ:
- Каждый заголовок ДОЛЖЕН содержать РОВНО 27 слов (строго!)
- Все три заголовка должны иметь ОДИНАКОВОЕ количество слов
- Это необходимо для синхронизации скорости начитки
- Считай слова внимательно перед отправкой ответа

ПРАВИЛА:
1. Сохраняй ВСЕ факты: даты, места, числа, имена
2. НЕ добавляй информацию, которой нет в исходном тексте
3. НЕ добавляй эмоции, оценки, метафоры - только факты
4. Каждый заголовок: РОВНО 27 слов, законченная мысль
5. Хронологический порядок: начало → развитие → итоги

ФОРМАТ ОТВЕТА: Только JSON-массив из 3 строк, каждая строго 27 слов:
["первый заголовок ровно 27 слов", "второй заголовок ровно 27 слов", "третий заголовок ровно 27 слов"]`
          },
          {
            role: 'user',
            content: `Перепиши этот текст в 3 новостных заголовка. КАЖДЫЙ заголовок должен содержать РОВНО 27 слов (строго одинаковое количество для всех трёх):\n\n${text}`
          }
        ]
      })
    });

    if (!response.ok) {
      console.error('OpenAI HTTP error', response.status, await response.text());
      return null;
    }

    const data: any = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    console.log(`OpenAI raw content:`, rawContent?.slice(0, 200));

    const parsedArr = tryParseArray(rawContent || '');
    if (!parsedArr) return null;
    
    const normalized = parsedArr.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
    // Выравниваем количество слов до одинакового
    const equalized = equalizeWordCount(normalized);
    
    // Логируем количество слов для проверки
    const wordCounts = equalized.map(b => b.split(/\s+/).filter(Boolean).length);
    console.log(`[OpenAI] Количество слов после нормализации:`, wordCounts);
    
    return equalized;
  } catch (err) {
    console.error('OpenAI error', err);
    return null;
  }
}

export async function rewriteNewsText(text: string): Promise<string[]> {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!cleanText) return ['', '', ''];

  // Режим сравнения: пробуем оба и логируем результаты
  if (AI_PROVIDER === 'both' && HAS_OPENAI && HAS_PERPLEXITY) {
    console.log('[AI Comparison] Тестирую оба провайдера...');
    
    const [openaiResult, perplexityResult] = await Promise.allSettled([
      tryOpenAI(cleanText),
      tryPerplexity(cleanText)
    ]);

    if (openaiResult.status === 'fulfilled' && openaiResult.value && openaiResult.value.length === 3) {
      const lens = openaiResult.value.map(p => p.split(' ').filter(Boolean).length);
      console.log('=== OpenAI результат ===');
      openaiResult.value.forEach((t, i) => console.log(`${i + 1}. [${lens[i]} слов] ${t}`));
    } else {
      console.log('=== OpenAI: ошибка ===', openaiResult.status === 'rejected' ? openaiResult.reason : 'неверный формат');
    }

    if (perplexityResult.status === 'fulfilled' && perplexityResult.value && perplexityResult.value.length === 3) {
      const lens = perplexityResult.value.map(p => p.split(' ').filter(Boolean).length);
      console.log('=== Perplexity результат ===');
      perplexityResult.value.forEach((t, i) => console.log(`${i + 1}. [${lens[i]} слов] ${t}`));
    } else {
      console.log('=== Perplexity: ошибка ===', perplexityResult.status === 'rejected' ? perplexityResult.reason : 'неверный формат');
    }

    // Возвращаем результат OpenAI (приоритет)
    if (openaiResult.status === 'fulfilled' && openaiResult.value && openaiResult.value.length === 3) {
      const normalized = openaiResult.value.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
      return equalizeWordCount(normalized);
    }
    if (perplexityResult.status === 'fulfilled' && perplexityResult.value && perplexityResult.value.length === 3) {
      const normalized = perplexityResult.value.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
      return equalizeWordCount(normalized);
    }
  }

  // Режим выбора провайдера
  if (AI_PROVIDER === 'openai' && HAS_OPENAI) {
    const openaiResult = await tryOpenAI(cleanText);
    if (openaiResult && openaiResult.length === 3) {
      const normalized = openaiResult.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
      const equalized = equalizeWordCount(normalized);
      const lens = equalized.map(p => p.split(' ').filter(Boolean).length);
      console.log('OpenAI success, lengths:', lens);
      return equalized;
    }
  }

  if (AI_PROVIDER === 'perplexity' || (AI_PROVIDER === 'openai' && !HAS_OPENAI)) {
    const perplexityResult = await tryPerplexity(cleanText);
    if (perplexityResult && perplexityResult.length === 3) {
      const normalized = perplexityResult.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
      const equalized = equalizeWordCount(normalized);
      const lens = equalized.map(p => p.split(' ').filter(Boolean).length);
      console.log('Perplexity success, lengths:', lens);
      return equalized;
    }
  }

  // Автоматический выбор (по умолчанию): только OpenAI
  if (HAS_OPENAI && AI_PROVIDER !== 'perplexity') {
    const openaiResult = await tryOpenAI(cleanText);
    if (openaiResult && openaiResult.length === 3) {
      const normalized = openaiResult.map((s: string) => normalizeBlock(s, TARGET_WORDS_PER_SLIDE));
      const equalized = equalizeWordCount(normalized);
      const lens = equalized.map(p => p.split(' ').filter(Boolean).length);
      console.log('OpenAI success, lengths:', lens);
      return equalized;
    }
  }

  // Perplexity отключен - используем только OpenAI или fallback
  // Если OpenAI не сработал, переходим к алгоритмическому fallback

  // Надёжный алгоритмический фоллбек: создаём 3 слайда строго по TARGET_WORDS_PER_SLIDE слов
  const words = cleanText.split(' ').filter(Boolean);
  const total = words.length;

  if (total === 0) return ['', '', ''];

  // Если текста достаточно для 3 слайдов по TARGET_WORDS_PER_SLIDE слов
  if (total >= TARGET_WORDS_PER_SLIDE * 3) {
    const blocks = [
      words.slice(0, TARGET_WORDS_PER_SLIDE).join(' '),
      words.slice(TARGET_WORDS_PER_SLIDE, TARGET_WORDS_PER_SLIDE * 2).join(' '),
      words.slice(TARGET_WORDS_PER_SLIDE * 2, TARGET_WORDS_PER_SLIDE * 3).join(' ')
    ];
    const normalized = blocks.map((b: string) => normalizeBlock(b, TARGET_WORDS_PER_SLIDE));
    const equalized = equalizeWordCount(normalized);
    console.log('Fallback split (достаточно слов), lengths:', equalized.map(b => b.split(' ').filter(Boolean).length));
    return equalized;
  }

  // Если текста меньше - делим равномерно, но выравниваем до одинакового количества
  const wordsPerSlide = Math.max(1, Math.floor(total / 3));
  const blocks = [
    words.slice(0, wordsPerSlide).join(' '),
    words.slice(wordsPerSlide, wordsPerSlide * 2).join(' '),
    words.slice(wordsPerSlide * 2).join(' ')
  ];

  const normalized = blocks.map((b: string) => normalizeBlock(b, TARGET_WORDS_PER_SLIDE));
  const equalized = equalizeWordCount(normalized);
  console.log('Fallback split (мало слов), lengths:', equalized.map(b => b.split(' ').filter(Boolean).length));
  return equalized;
}

