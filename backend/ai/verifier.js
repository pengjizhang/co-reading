const { cleanText, refusal } = require('./contracts');

class AnswerVerifier {
  constructor() { this.id = 'citation-verifier-v2'; }

  verify(candidate, contextPackage) {
    if (!contextPackage.evidence.length) return { ...refusal(), verification: { valid: true, supportedClaims: 0, totalClaims: 0, warnings: [] } };
    const evidenceById = new Map(contextPackage.evidence.map((item) => [item.id, item]));
    const rawClaims = Array.isArray(candidate?.claims) ? candidate.claims : [];
    const warnings = [];
    const claims = rawClaims.map((claim, index) => {
      const requestedIds = claim.citationIds || claim.citations || claim.evidence || claim.evidenceIds || claim.refs || [];
      const citationIds = [...new Set((Array.isArray(requestedIds) ? requestedIds : [requestedIds])
        .map((item) => String(item?.id || item?.evidenceId || item || '').toUpperCase())
        .filter((id) => evidenceById.has(id)))];
      const text = cleanText(claim.text || claim.claim || claim.statement, 1200);
      const supported = Boolean(text && citationIds.length);
      if (!supported) warnings.push(`claim_${index + 1}_unsupported`);
      return { id: `C${index + 1}`, text, citationIds, supported };
    }).filter((claim) => claim.text && claim.supported);
    const citationIds = [...new Set(claims.flatMap((claim) => claim.citationIds))];
    const citations = citationIds.map((id) => evidenceById.get(id));
    if (!claims.length) return {
      ...refusal('verification_failed'),
      citations: [],
      verification: { valid: false, supportedClaims: 0, totalClaims: rawClaims.length, warnings: warnings.length ? warnings : ['no_supported_claims'] },
    };
    const answer = cleanText(candidate.answer, 6000) || claims.map((claim) => claim.text).join('；');
    return {
      answer,
      claims,
      citations,
      refused: false,
      refusalReason: null,
      verification: { valid: warnings.length === 0, supportedClaims: claims.length, totalClaims: rawClaims.length, warnings },
    };
  }
}

module.exports = { AnswerVerifier };
