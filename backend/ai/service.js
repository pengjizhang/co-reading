const { cleanText, planQuery } = require('./contracts');
const { StructureAwareRetriever } = require('./retrieval');
const { ContextCompiler } = require('./context');
const { ProviderRouter } = require('./providers');
const { AnswerVerifier } = require('./verifier');

function preserveText(value, maximum = 12000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function acceptWorkAgentResult(candidate, contextPackage) {
  const evidenceById = new Map((contextPackage.evidence || []).map((item) => [String(item.id), item]));
  const rawClaims = Array.isArray(candidate?.claims) ? candidate.claims : [];
  const warnings = [];
  const claims = rawClaims.map((claim, index) => {
    const evidenceIds = [...new Set((claim.citationIds || claim.evidence || [])
      .map((id) => String(id).toUpperCase())
      .filter(Boolean))];
    const citationIds = evidenceIds.filter((id) => evidenceById.has(id));
    const missingIds = evidenceIds.filter((id) => !evidenceById.has(id));
    const text = cleanText(claim.text || claim.claim, 1600);
    if (!citationIds.length) warnings.push(`claim_${index + 1}_without_local_evidence`);
    if (missingIds.length) warnings.push(`claim_${index + 1}_unknown_evidence:${missingIds.join(',')}`);
    return {
      id: `C${index + 1}`,
      text,
      evidenceIds,
      citationIds,
      supported: citationIds.length > 0,
    };
  }).filter((claim) => claim.text);
  if (!claims.length) warnings.push('workagent_answer_without_claims');
  const citationIds = [...new Set(claims.flatMap((claim) => claim.citationIds))];
  return {
    answer: preserveText(candidate?.answer),
    claims,
    citations: citationIds.map((id) => evidenceById.get(id)),
    refused: false,
    refusalReason: null,
    verification: {
      valid: warnings.length === 0,
      supportedClaims: claims.filter((claim) => claim.supported).length,
      totalClaims: claims.length,
      warnings,
      protocol: candidate?.workagentProtocol || 'reader-collaboration-v1',
    },
  };
}

class BookAIService {
  constructor(options = {}) {
    this.retriever = options.retriever || new StructureAwareRetriever();
    this.compiler = options.compiler || new ContextCompiler();
    this.providers = options.providers || new ProviderRouter();
    this.verifier = options.verifier || new AnswerVerifier();
    this.recordRun = options.recordRun || (() => {});
  }

  capabilities() {
    return {
      schemaVersion: 1,
      architecture: {
        retriever: this.retriever.id,
        contextCompiler: this.compiler.id,
        verifier: this.verifier.id,
      },
      ...this.providers.capabilities(),
    };
  }

  async probeCapabilities() {
    const providerCapabilities = this.providers.probeCapabilities
      ? await this.providers.probeCapabilities()
      : this.providers.capabilities();
    return {
      schemaVersion: 1,
      architecture: {
        retriever: this.retriever.id,
        contextCompiler: this.compiler.id,
        verifier: this.verifier.id,
      },
      ...providerCapabilities,
    };
  }

  async ask(input, publications) {
    const started = Date.now();
    const plan = planQuery(input);
    if (!plan.bookIds.length) plan.bookIds = publications.map((item) => item.bookId);
    const retrieved = await this.retriever.retrieve(plan, publications);
    const contextPackage = this.compiler.compile(plan, retrieved);
    const providerResult = await this.providers.answer(plan, contextPackage);
    const isWorkAgent = String(providerResult.provider || '').startsWith('workagent:');
    const verified = isWorkAgent
      ? acceptWorkAgentResult(providerResult.candidate, contextPackage)
      : this.verifier.verify(providerResult.candidate, contextPackage);
    const result = {
      schemaVersion: 1,
      runId: plan.id,
      question: plan.question,
      questionSource: plan.questionSource,
      mode: plan.mode,
      intent: plan.intent,
      answer: verified.answer,
      claims: verified.claims,
      sources: verified.citations,
      refused: verified.refused,
      refusalReason: verified.refusalReason,
      provider: providerResult.provider,
      fallback: providerResult.fallback,
      fallbackFrom: providerResult.fallbackFrom || [],
      fallbackReason: providerResult.providerError || null,
      providerNotice: providerResult.candidate?.providerNotice || null,
      agentResponse: isWorkAgent ? providerResult.candidate?._agentPayload || null : null,
      understanding: {
        expanded: verified.refused ? '' : preserveText(providerResult.candidate?.expandedUnderstanding, 10000),
        external: verified.refused ? '' : preserveText(providerResult.candidate?.externalExtension, 8000),
        externalSources: !verified.refused && Array.isArray(providerResult.candidate?.externalSources)
          ? providerResult.candidate.externalSources
          : [],
        limitations: Array.isArray(providerResult.candidate?.limitations)
          ? providerResult.candidate.limitations.map((item) => cleanText(item, 800)).filter(Boolean)
          : [],
        followUpQuestions: Array.isArray(providerResult.candidate?.followUpQuestions)
          ? providerResult.candidate.followUpQuestions.map((item) => cleanText(item, 800)).filter(Boolean)
          : [],
      },
      verification: verified.verification,
      diagnostics: {
        retrievedEvidence: retrieved.length,
        usedEvidence: contextPackage.evidence.length,
        contextCharacters: contextPackage.budget.usedCharacters,
        traceId: providerResult.trace?.traceId || null,
        taskId: providerResult.trace?.taskId || null,
        jobId: providerResult.trace?.jobId || null,
        workagentElapsedMs: providerResult.trace?.elapsedMs || null,
        elapsedMs: Date.now() - started,
      },
    };
    this.recordRun({
      id: plan.id,
      bookIds: plan.bookIds,
      question: plan.question,
      mode: plan.mode,
      intent: plan.intent,
      provider: result.provider,
      fallback: result.fallback,
      refused: result.refused,
      evidenceCount: result.sources.length,
      durationMs: result.diagnostics.elapsedMs,
      verification: result.verification,
      providerError: providerResult.providerError || null,
    });
    return result;
  }
}

module.exports = { BookAIService };
