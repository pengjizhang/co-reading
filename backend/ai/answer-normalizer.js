const { cleanText } = require('./contracts');

function outputText(value, maximum = 12000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function jsonCandidates(text) {
  const trimmed = String(text || '').trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  return [...new Set(candidates)].filter(Boolean);
}

function parseObject(text) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function citationIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').match(/\bE\d+\b/gi) || [];
  return [...new Set(raw.map((item) => {
    if (item && typeof item === 'object') return item.id || item.evidenceId || item.ref || '';
    return item;
  }).map((item) => String(item).toUpperCase()).filter((item) => /^E\d+$/.test(item)))];
}

function normalizeClaims(rawClaims = []) {
  if (!Array.isArray(rawClaims)) return [];
  return rawClaims.map((claim) => ({
    text: cleanText(typeof claim === 'string' ? claim : claim?.text || claim?.claim || claim?.statement, 1400),
    citationIds: citationIds(typeof claim === 'string'
      ? claim
      : claim?.citationIds || claim?.citations || claim?.evidence || claim?.evidenceIds || claim?.refs),
  })).filter((claim) => claim.text);
}

function claimsFromText(text) {
  return String(text || '')
    .split(/\n+|(?<=[。！？；])\s*/)
    .map((part) => {
      const ids = citationIds(part);
      return { text: cleanText(part.replace(/\s*\[(E\d+)\]\s*/gi, ' '), 1400), citationIds: ids };
    })
    .filter((claim) => claim.text && claim.citationIds.length);
}

function stringList(value, maximum = 6) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => cleanText(item, 800)).filter(Boolean).slice(0, maximum);
}

function externalSources(value) {
  if (!Array.isArray(value)) return [];
  return value.map((source) => ({
    title: cleanText(source?.title, 300),
    url: /^https?:\/\//i.test(String(source?.url || '')) ? String(source.url) : '',
    quote: cleanText(source?.quote || source?.excerpt, 600),
  })).filter((source) => source.title && source.url).slice(0, 8);
}

class AnswerNormalizer {
  constructor() {
    this.id = 'workagent-answer-normalizer-v3';
  }

  normalize(message) {
    const parsed = parseObject(message);
    if (parsed) {
      const answer = outputText(parsed.answer || parsed.bookConclusion || parsed.summary, 12000);
      const claims = normalizeClaims(parsed.claims);
      if (!answer) {
        const error = new Error('WorkAgent 结构化回答缺少 answer');
        error.code = 'WORKAGENT_EMPTY_RESPONSE';
        throw error;
      }
      const expandedUnderstanding = outputText(parsed.expandedUnderstanding || parsed.explanation, 10000);
      const externalExtension = outputText(parsed.externalExtension, 8000);
      const normalizedExternalSources = externalSources(parsed.externalSources);
      const limitations = stringList(parsed.limitations);
      const followUpQuestions = stringList(parsed.followUpQuestions || parsed.followups, 5);
      return {
        answer,
        claims,
        expandedUnderstanding,
        externalExtension,
        externalSources: normalizedExternalSources,
        limitations,
        followUpQuestions,
        requestId: parsed.requestId || null,
        workagentProtocol: 'reader-collaboration-v1',
        _agentPayload: {
          answer,
          claims: claims.map((claim) => ({ claim: claim.text, evidence: claim.citationIds })),
          expandedUnderstanding: expandedUnderstanding || null,
          externalExtension: externalExtension || null,
          externalSources: normalizedExternalSources,
          limitations: limitations.length === 1 ? limitations[0] : limitations,
          requestId: parsed.requestId || null,
        },
      };
    }
    const answer = outputText(message, 12000);
    if (!answer) {
      const error = new Error('WorkAgent 返回了空回答');
      error.code = 'WORKAGENT_EMPTY_RESPONSE';
      throw error;
    }
    const claims = claimsFromText(message);
    return {
      answer,
      claims,
      expandedUnderstanding: '',
      externalExtension: '',
      externalSources: [],
      limitations: [],
      followUpQuestions: [],
      requestId: null,
      workagentProtocol: 'reader-collaboration-v1',
      _agentPayload: {
        answer,
        claims: claims.map((claim) => ({ claim: claim.text, evidence: claim.citationIds })),
        expandedUnderstanding: null,
        externalExtension: null,
        externalSources: [],
        limitations: [],
        requestId: null,
      },
    };
  }
}

module.exports = { AnswerNormalizer, parseObject, claimsFromText };
