import { config } from 'dotenv';
config();

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const HAS_PERPLEXITY = Boolean(PERPLEXITY_API_KEY);

const FETCH_TIMEOUT_MS = 6000;
const MAX_AI_WORDS = 26;
const AI_RETRIES = 2;

function capitalizeFirst(str: string) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function normalizeBlock(raw: string) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/).slice(0, MAX_AI_WORDS);
  let sentence = words.join(' ');
  if (!/[.!?…]$/.test(sentence)) {
    sentence = sentence + '.';
  }
  return capitalizeFirst(sentence);
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
          content: [
            'Ты профессиональный редактор новостной ленты. Перепиши исходный текст по-русски в РОВНО 3 полных абзаца-хронологию.',
            'ТРЕБОВАНИЯ К КАЖДОМУ АБЗАЦУ:',
            '- Длина: 20–25 слов (строго, допустимо 18–26 только если текст очень короткий)',
            '- Полные предложения, законченные мысли',
            '- Хронологический порядок событий',
            '- Сохранение всех фактов, чисел, дат, локаций',
            '- Нейтральный стиль, без метафор, оценок, клише',
            '- Конкретные субъекты вместо местоимений',
            '- Связный текст, избегай перечислений без связки',
            '',
            'НЕ добавляй ничего нового, НЕ сокращай ключевые детали, НЕ используй обрывки фраз.',
            '',
            'Верни ТОЛЬКО валидный JSON-массив из РОВНО трёх строк: ["первый абзац", "второй абзац", "третий абзац"]',
            'БЕЗ пояснений, БЕЗ форматирования Markdown, БЕЗ обратных кавычек.'
          ].join('\n')
              },
              { role: 'user', content: text }
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
        const normalized = parsedArr.map((s: string) => normalizeBlock(s));
        return normalized;
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

export async function rewriteNewsText(text: string): Promise<string[]> {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!cleanText) return ['', '', ''];

  // Пробуем Perplexity
  const ai = await tryPerplexity(cleanText);
  if (ai && ai.length === 3) {
    const lens = ai.map(p => p.split(' ').filter(Boolean).length);
    console.log('Perplexity success, lengths:', lens);
    return ai.map(normalizeBlock);
  }

  // Надёжный алгоритмический фоллбек: равномерное деление в 3 части, целимся в ~23 слова
  const words = cleanText.split(' ').filter(Boolean);
  const total = words.length;

  if (total === 0) return ['', '', ''];

  const target = 23;
  // Если текст короткий — равномерно
  if (total <= target * 3) {
    const base = Math.floor(total / 3);
    const rem = total % 3;
    const sizes = [
      base + (rem > 0 ? 1 : 0),
      base + (rem > 1 ? 1 : 0),
      base
    ];
    console.log('Fallback split short, lengths:', sizes);
    return [
      words.slice(0, sizes[0]).join(' '),
      words.slice(sizes[0], sizes[0] + sizes[1]).join(' '),
      words.slice(sizes[0] + sizes[1]).join(' ')
    ].map(capitalizeFirst);
  }

  // Длинный текст: делим равномерно, чтобы покрыть весь текст
  const base = Math.floor(total / 3);
  const rem = total % 3;
  const size1 = base + (rem > 0 ? 1 : 0);
  const size2 = base + (rem > 1 ? 1 : 0);
  const size3 = total - size1 - size2;

  const blocks = [
    words.slice(0, size1).join(' '),
    words.slice(size1, size1 + size2).join(' '),
    words.slice(size1 + size2).join(' ')
  ];

  const normalized = blocks.map(normalizeBlock);
  console.log('Fallback split, lengths:', normalized.map(b => b.split(' ').filter(Boolean).length));
  return normalized;
}

